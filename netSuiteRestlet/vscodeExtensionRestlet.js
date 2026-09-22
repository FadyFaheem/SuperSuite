/**
 * SuperSuite File Cabinet, field-metadata and record inspection service (protocol 2).
 *
 * Deploy using an authenticated, least-privilege integration role. NetSuite
 * validates OAuth/TBA before an entry point runs; never put tokens in this file.
 * Optional Free-Form Text script parameter: custscript_supersuite_root.
 * Its default is SuiteScripts; set it to a narrower SuiteScripts/project path
 * to restrict this deployment independently of the client's configuration.
 * Optional Checkbox parameter: custscript_supersuite_readonly. Enable it on a
 * dedicated AI inspection deployment to reject every File Cabinet mutation.
 *
 * Requests are deliberately bounded. A batch is not a transaction: inspect
 * every result and retry only failed items marked retryable. See README.md in
 * this directory for the wire contract, deployment, and operational limits.
 *
 * @NApiVersion 2.1
 * @NScriptType Restlet
 * @NModuleScope SameAccount
 */
define(['N/file', 'N/search', 'N/record', 'N/runtime', 'N/log'],
  (file, search, record, runtime, log) => {
    'use strict';

    const VERSION = '2.2.0';
    const STAGING_FOLDER = '.supersuite-staging';
    const LIMITS = Object.freeze({
      maxBatchFiles: 20,
      maxBatchBytes: 4 * 1024 * 1024,
      maxFileBytes: 3 * 1024 * 1024,
      pageSize: 100,
      maxPageSize: 200,
      maxRecordPageSize: 10,
      maxRecordBytes: 3 * 1024 * 1024
    });
    // Reserve units for scratch cleanup and a small error response. A platform
    // hard governance exception may terminate execution without running finally.
    const USAGE_RESERVE = 250;
    const RESPONSE_RESERVE = 64 * 1024;
    // An explicit read-only allowlist limits accidental whole-account exports.
    const EXPORT_TYPES = new Set(['customer', 'vendor', 'contact', 'salesorder',
      'invoice', 'purchaseorder', 'vendorbill', 'creditmemo', 'cashsale', 'customerpayment']);
    const FILTER_OPERATORS = new Set(['is', 'isnot', 'equalto', 'notequalto', 'anyof', 'noneof',
      'contains', 'doesnotcontain', 'startswith', 'doesnotstartwith', 'greaterthan',
      'greaterthanorequalto', 'lessthan', 'lessthanorequalto', 'on', 'onorafter',
      'onorbefore', 'after', 'before', 'within', 'between', 'notbetween', 'isempty', 'isnotempty']);
    const RETRYABLE = new Set([
      'GOVERNANCE_LIMIT', 'BATCH_BYTES_EXCEEDED', 'SSS_REQUEST_LIMIT_EXCEEDED',
      'SSS_REQUEST_TIME_EXCEEDED', 'RCRD_LOCKED', 'RCRD_HAS_BEEN_CHANGED', 'STAGING_CLEANUP_FAILED'
    ]);
    const TYPES = {
      js: 'JAVASCRIPT', json: 'JSON', ts: 'PLAINTEXT', jsx: 'PLAINTEXT',
      tsx: 'PLAINTEXT', mjs: 'PLAINTEXT', cjs: 'PLAINTEXT', txt: 'PLAINTEXT',
      md: 'PLAINTEXT', log: 'PLAINTEXT', sql: 'PLAINTEXT', yaml: 'PLAINTEXT',
      yml: 'PLAINTEXT', csv: 'CSV', xml: 'XMLDOC', xsd: 'XSD',
      html: 'HTMLDOC', htm: 'HTMLDOC', css: 'STYLESHEET', scss: 'SCSS',
      svg: 'SVG', ftl: 'FREEMARKER', config: 'CONFIG', appcache: 'APPCACHE',
      ssp: 'WEBAPPPAGE', ss: 'WEBAPPSCRIPT', eml: 'MESSAGERFC',
      pdf: 'PDF', png: 'PNGIMAGE', jpg: 'JPGIMAGE', jpeg: 'JPGIMAGE',
      gif: 'GIFIMAGE', bmp: 'BMPIMAGE', ico: 'ICON', tif: 'TIFFIMAGE',
      tiff: 'TIFFIMAGE', zip: 'ZIP', gz: 'GZIP', tar: 'TAR',
      xls: 'EXCEL', xlsx: 'EXCEL', doc: 'WORD', docx: 'WORD',
      ppt: 'POWERPOINT', pptx: 'POWERPOINT', rtf: 'RTF',
      mp3: 'MP3', mpg: 'MPEGMOVIE', mpeg: 'MPEGMOVIE', mov: 'QUICKTIME'
    };

    /** UTF-8 size without Node globals, including supplementary characters. */
    function byteLength(value) {
      let bytes = 0;
      for (let i = 0; i < value.length; i += 1) {
        const code = value.charCodeAt(i);
        if (code < 0x80) bytes += 1;
        else if (code < 0x800) bytes += 2;
        else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length &&
          value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) {
          bytes += 4;
          i += 1;
        } else bytes += 3;
      }
      return bytes;
    }

    function fail(code, message) {
      const error = new Error(message);
      error.name = code;
      throw error;
    }

    function errorDetails(error) {
      const code = String(error.name || error.code || 'UNEXPECTED_ERROR');
      return { code, message: String(error.message || 'NetSuite request failed.').slice(0, 500),
        retryable: RETRYABLE.has(code) };
    }

    function checkUsage() {
      if (runtime.getCurrentScript().getRemainingUsage() < USAGE_RESERVE) {
        fail('GOVERNANCE_LIMIT', 'Retry the unprocessed file in a new request.');
      }
    }

    function readOnlyMode() {
      const value = runtime.getCurrentScript().getParameter({ name: 'custscript_supersuite_readonly' });
      return value === true || value === 'T';
    }

    function credentialField(field, metadata) {
      return Boolean(metadata && /password/i.test(String(metadata.type))) ||
        /password|passwd|access.?token|consumer.?secret|token.?secret|private.?key|api.?key|credential/i.test(field);
    }

    /** Reject ambiguous paths instead of normalizing away traversal. */
    function canonicalPath(value) {
      if (typeof value !== 'string' || !value || value.length > 1024 ||
        /[\\\x00-\x1f\x7f:%]/.test(value)) {
        fail('INVALID_PATH', 'Use a File Cabinet path with forward slashes.');
      }
      const parts = value.split('/');
      if (parts.length > 32 || parts.some(part => !part || part === '.' || part === '..' ||
        part.toLowerCase() === STAGING_FOLDER)) {
        fail('INVALID_PATH', 'Paths may not contain empty, dot, parent, or reserved segments.');
      }
      return value;
    }

    function context() {
      const configured = runtime.getCurrentScript().getParameter({ name: 'custscript_supersuite_root' });
      const root = canonicalPath(configured || 'SuiteScripts');
      if (root !== 'SuiteScripts' && !root.startsWith('SuiteScripts/')) {
        fail('INVALID_ROOT', 'The deployment root must be SuiteScripts or one of its subfolders.');
      }
      return { root, folders: Object.create(null), stagingId: null, stagedIds: [] };
    }

    function scopedPath(value, ctx, isFile = false) {
      const path = canonicalPath(value);
      if (path !== ctx.root && !path.startsWith(ctx.root + '/')) {
        fail('PATH_OUTSIDE_ROOT', 'The requested path is outside the deployment root.');
      }
      if (isFile && path === ctx.root) fail('INVALID_PATH', 'A file path must include its name.');
      return path;
    }

    function sortedColumn(name) {
      return search.createColumn({ name, sort: search.Sort.ASC });
    }

    function findFolder(name, parent) {
      const filters = [['name', 'is', name], 'AND', parent === null ?
        ['istoplevel', 'is', 'T'] : ['parent', 'anyof', String(parent)]];
      const matches = search.create({ type: search.Type.FOLDER, filters,
        columns: [sortedColumn('internalid')] }).run().getRange({ start: 0, end: 2 });
      if (matches.length > 1) fail('AMBIGUOUS_PATH', 'More than one folder has the requested name.');
      return matches.length ? Number(matches[0].id) : null;
    }

    /** Only push creates descendants; the configured root must already exist. */
    function resolveFolder(path, ctx, create = false) {
      if (ctx.folders[path]) return ctx.folders[path];
      const parts = path.split('/');
      let parent = null;
      let current = '';
      for (const name of parts) {
        checkUsage();
        current = current ? current + '/' + name : name;
        let id = ctx.folders[current] || findFolder(name, parent);
        if (!id) {
          if (!create || !current.startsWith(ctx.root + '/')) {
            fail('FOLDER_NOT_FOUND', 'Folder not found or inaccessible: ' + current);
          }
          const folder = record.create({ type: record.Type.FOLDER, isDynamic: false });
          folder.setValue({ fieldId: 'name', value: name });
          folder.setValue({ fieldId: 'parent', value: parent });
          id = Number(folder.save());
        }
        ctx.folders[current] = id;
        parent = id;
      }
      return parent;
    }

    /**
     * Keyset pagination lists direct child folders, then direct files. Internal
     * ID cursors avoid the ResultSet.each limit and offset drift after a prior
     * item is deleted. Concurrent edits still mean this is not a snapshot.
     */
    function list(request, ctx) {
      const path = scopedPath(request.path, ctx);
      const folderId = resolveFolder(path, ctx);
      const pageSize = request.pageSize === undefined ? LIMITS.pageSize : Number(request.pageSize);
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > LIMITS.maxPageSize) {
        fail('INVALID_PAGE_SIZE', 'pageSize must be between 1 and ' + LIMITS.maxPageSize + '.');
      }
      const cursor = request.cursor || 'd:0';
      if (typeof cursor !== 'string' || !/^[df]:\d{1,15}$/.test(cursor)) {
        fail('INVALID_CURSOR', 'Use the nextCursor returned by the preceding list response.');
      }
      const phase = cursor[0];
      const after = Number(cursor.slice(2));
      const folderPhase = phase === 'd';
      const filters = [[folderPhase ? 'parent' : 'folder', 'anyof', String(folderId)],
        'AND', ['internalidnumber', 'greaterthan', after]];
      if (folderPhase) filters.push('AND', ['name', 'isnot', STAGING_FOLDER]);
      // File is a search-only record with ID 'file'; search.Type has no FILE
      // member in Oracle's published enum (unlike search.Type.FOLDER).
      const rows = search.create({ type: folderPhase ? search.Type.FOLDER : 'file',
        filters, columns: [sortedColumn('internalid'), 'name']
      }).run().getRange({ start: 0, end: pageSize + 1 });
      const entries = rows.slice(0, pageSize).map(row => {
        const name = String(row.getValue({ name: 'name' }));
        return { type: folderPhase ? 'folder' : 'file', id: String(row.id), name,
          path: scopedPath(path + '/' + name, ctx) };
      });
      const nextCursor = rows.length > pageSize ? phase + ':' + entries[entries.length - 1].id :
        (folderPhase ? 'f:0' : null);
      return { ok: true, path, entries, nextCursor };
    }

    function loadFile(path) {
      // Cabinet-absolute paths never resolve relative to this script's folder.
      // Do not accept internal IDs from the client: that would bypass the root.
      return file.load({ id: path });
    }

    function pullOne(item, ctx) {
      const path = scopedPath(item.path, ctx, true);
      const source = loadFile(path);
      if (Number(source.size) > LIMITS.maxFileBytes) {
        fail('FILE_TOO_LARGE', 'File exceeds the ' + LIMITS.maxFileBytes + '-byte transfer limit.');
      }
      return { ok: true, path, id: String(source.id), size: Number(source.size),
        encoding: source.isText ? 'utf8' : 'base64', content: source.getContents() };
    }

    function validateContents(item) {
      if (typeof item.content !== 'string' || !['utf8', 'base64'].includes(item.encoding)) {
        fail('INVALID_CONTENT', 'content must be a string and encoding must be utf8 or base64.');
      }
      let size;
      if (item.encoding === 'base64') {
        if (item.content.length % 4 !== 0 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(item.content)) {
          fail('INVALID_BASE64', 'Binary content must use padded, standard base64.');
        }
        size = item.content.length / 4 * 3 - (item.content.endsWith('==') ? 2 : item.content.endsWith('=') ? 1 : 0);
      } else size = byteLength(item.content);
      if (size > LIMITS.maxFileBytes) fail('FILE_TOO_LARGE', 'File exceeds the transfer limit.');
      return size;
    }

    function stagingFolder(ctx) {
      if (ctx.stagingId) return ctx.stagingId;
      const stagingRoot = resolveFolder(ctx.root + '/' + STAGING_FOLDER, ctx, true);
      const folder = record.create({ type: record.Type.FOLDER, isDynamic: false });
      // Each request owns exactly one new folder. Never adopt another request's
      // folder, including when cleaning up after a request timeout.
      folder.setValue({ fieldId: 'name', value: 'request-' + Date.now() + '-' + Math.random().toString(36).slice(2) });
      folder.setValue({ fieldId: 'parent', value: stagingRoot });
      ctx.stagingId = Number(folder.save());
      return ctx.stagingId;
    }

    function pushOne(item, ctx) {
      if (ctx.stagedIds.length) {
        fail('STAGING_CLEANUP_FAILED', 'Retry in a new request after staging cleanup has recovered.');
      }
      const path = scopedPath(item.path, ctx, true);
      const size = validateContents(item);
      const slash = path.lastIndexOf('/');
      const name = path.slice(slash + 1);
      const parentPath = path.slice(0, slash);
      let existing = null;
      try { existing = loadFile(path); } catch (error) {
        if (error.name !== 'RCRD_DSNT_EXIST') throw error;
      }
      const extension = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
      const typeName = TYPES[extension] || (item.encoding === 'utf8' ? 'PLAINTEXT' : null);
      const fileType = existing ? existing.fileType : typeName && file.Type[typeName];
      if (!fileType) fail('UNSUPPORTED_FILE_TYPE', 'Unsupported binary extension: ' + extension);
      const staged = file.create({ name, fileType, contents: item.content,
        isOnline: false, encoding: item.encoding === 'utf8' ? file.Encoding.UTF8 : undefined });
      if (Boolean(staged.isText) !== (item.encoding === 'utf8')) {
        fail('ENCODING_MISMATCH', 'The supplied encoding does not match the NetSuite file type.');
      }
      const destination = resolveFolder(parentPath, ctx, true);
      staged.folder = stagingFolder(ctx);
      const temporaryId = Number(staged.save());
      ctx.stagedIds.push(temporaryId);
      checkUsage();
      // N/file has no content setter. Documented OVERWRITE copy semantics retain
      // destination attributes/permissions and make path retries idempotent.
      // The live destination is never deleted before the replacement is saved.
      const saved = file.copy({ id: temporaryId, folder: destination,
        conflictResolution: file.NameConflictResolution.OVERWRITE });
      cleanupStagedFile(temporaryId, ctx);
      return { ok: true, path, id: String(saved.id), size, encoding: item.encoding };
    }

    function cleanupStagedFile(id, ctx) {
      try {
        file.delete({ id });
        ctx.stagedIds = ctx.stagedIds.filter(value => value !== id);
      } catch (error) {
        // Destination may already be committed; report upload success even if
        // scratch cleanup fails. Logs contain identifiers, never file content.
        log.error({ title: 'SuperSuite staging cleanup', details: { id, code: String(error.name) } });
      }
    }

    function cleanup(ctx) {
      for (const id of ctx.stagedIds.slice()) cleanupStagedFile(id, ctx);
      if (ctx.stagingId && ctx.stagedIds.length === 0) {
        try { record.delete({ type: record.Type.FOLDER, id: ctx.stagingId }); } catch (error) {
          log.error({ title: 'SuperSuite staging folder cleanup',
            details: { id: ctx.stagingId, code: String(error.name) } });
        }
      }
    }

    /** Process this request's chunk and preserve successful per-file results. */
    function batch(request, ctx, push) {
      if (!Array.isArray(request.files) || request.files.length < 1 || request.files.length > LIMITS.maxBatchFiles) {
        fail('INVALID_BATCH', 'A batch must contain 1 to ' + LIMITS.maxBatchFiles + ' files.');
      }
      const results = [];
      let responseBytes = RESPONSE_RESERVE;
      try {
        for (const item of request.files) {
          try {
            checkUsage();
            if (!item || typeof item !== 'object') fail('INVALID_FILE', 'Each file must be an object.');
            const result = push ? pushOne(item, ctx) : pullOne(item, ctx);
            const bytes = byteLength(JSON.stringify(result)) + 1;
            if (bytes + RESPONSE_RESERVE > LIMITS.maxBatchBytes) {
              fail('FILE_RESPONSE_TOO_LARGE', 'Encoded file exceeds the response budget; use a smaller file.');
            }
            if (responseBytes + bytes > LIMITS.maxBatchBytes) {
              fail('BATCH_BYTES_EXCEEDED', 'Retry this file in a smaller pull batch.');
            }
            responseBytes += bytes;
            results.push(result);
          } catch (error) {
            results.push({ ok: false, path: item && typeof item.path === 'string' ? item.path.slice(0, 1024) : '',
              error: errorDetails(error) });
          }
        }
      } finally { cleanup(ctx); }
      return { ok: true, results };
    }

    /** Body metadata only: never read values/options or save a business record. */
    function metadata(request) {
      if (typeof request.recordType !== 'string' || !/^[a-z][a-z0-9_]{0,127}$/.test(request.recordType)) {
        fail('INVALID_RECORD_TYPE', 'Supply a SuiteScript record type or customrecord ID.');
      }
      const options = { type: request.recordType, isDynamic: false };
      let source;
      if (request.recordId !== undefined && request.recordId !== '') {
        if (!/^\d{1,15}$/.test(String(request.recordId)) || Number(request.recordId) < 1) {
          fail('INVALID_RECORD_ID', 'recordId must be a positive internal ID.');
        }
        source = record.load({ ...options, id: Number(request.recordId) });
      } else source = record.create(options);
      const fields = source.getFields().map(id => {
        const field = source.getField({ fieldId: id });
        return { id, label: field ? String(field.label || id) : id,
          type: field ? String(field.type || '') : '', isMandatory: Boolean(field && field.isMandatory) };
      });
      const result = { ok: true, recordType: request.recordType, fields,
        scope: 'body', source: request.recordId ? 'record' : 'new-record' };
      if (byteLength(JSON.stringify(result)) > LIMITS.maxBatchBytes) {
        fail('METADATA_TOO_LARGE', 'This record exposes more field metadata than the response limit.');
      }
      return result;
    }

    /**
     * Export values available to the authenticated role. Never call save/setValue
     * or log values. Summary fields hold subrecords; traverse those explicitly,
     * with bounded depth/cell/byte budgets. Omitted values are reported as issues.
     * record.load exposes at most 10,000 lines per sublist (Oracle platform limit).
     */
    function snapshot(source, budget, location, depth) {
      const data = { fields: Object.create(null), sublists: Object.create(null), subrecords: Object.create(null) };
      function issue(code, field) {
        budget.complete = false;
        budget.issueCount += 1;
        if (budget.issues.length < 100) budget.issues.push({ code, location: (location + '.' + field).slice(0, 512) });
      }
      function account(value, field) {
        budget.cells += 1;
        if (budget.cells > 100000) fail('RECORD_CELL_LIMIT', 'Record exceeds 100,000 exported values. Use a dedicated account export.');
        if (budget.cells % 128 === 0) checkUsage();
        if (value === undefined) { issue('VALUE_UNAVAILABLE', field); return null; }
        const serialized = JSON.stringify(value);
        if (serialized === undefined) { issue('VALUE_UNAVAILABLE', field); return null; }
        budget.bytes += byteLength(serialized) + byteLength(field) + 12;
        if (budget.bytes > LIMITS.maxRecordBytes - RESPONSE_RESERVE) {
          fail('RECORD_TOO_LARGE', 'Record exceeds the 3 MiB export limit. Use a dedicated account export.');
        }
        return value;
      }
      function capture(field, getter, target) {
        try { target[field] = account(getter(), field); } catch (error) {
          if (['GOVERNANCE_LIMIT', 'SSS_USAGE_LIMIT_EXCEEDED', 'RECORD_TOO_LARGE', 'RECORD_CELL_LIMIT'].includes(error.name)) throw error;
          issue('VALUE_UNAVAILABLE', field);
        }
      }
      function nested(field, getter, target, relativeLocation = field) {
        if (depth >= 2) { issue('SUBRECORD_DEPTH_LIMIT', relativeLocation); return; }
        capture(field, () => snapshot(getter(), budget, location + '.' + relativeLocation, depth + 1), target);
      }
      for (const fieldId of source.getFields()) {
        try {
          const field = source.getField({ fieldId });
          if (credentialField(fieldId, field)) { issue('CREDENTIAL_FIELD_OMITTED', fieldId); continue; }
          if (field && field.type === 'summary') {
            // hasSubrecord prevents getSubrecord from creating an empty subrecord.
            if (source.hasSubrecord({ fieldId })) nested(fieldId, () => source.getSubrecord({ fieldId }), data.subrecords);
          } else capture(fieldId, () => source.getValue({ fieldId }), data.fields);
        } catch (error) {
          if (['GOVERNANCE_LIMIT', 'SSS_USAGE_LIMIT_EXCEEDED', 'RECORD_TOO_LARGE', 'RECORD_CELL_LIMIT'].includes(error.name)) throw error;
          issue('FIELD_UNAVAILABLE', fieldId);
        }
      }
      for (const sublistId of source.getSublists()) {
        try {
          const count = source.getLineCount({ sublistId });
          const fieldIds = source.getSublistFields({ sublistId });
          if (!Number.isInteger(count) || count < 0) { issue('SUBLIST_UNAVAILABLE', sublistId); continue; }
          if (count >= 10000) issue('NETSUITE_10000_LINE_LIMIT', sublistId);
          const lines = [];
          for (let line = 0; line < Math.min(count, 10000); line += 1) {
            const row = { fields: Object.create(null), subrecords: Object.create(null) };
            for (const fieldId of fieldIds) {
              const key = sublistId + '[' + line + '].' + fieldId;
              try {
                const field = source.getSublistField({ sublistId, fieldId, line });
                if (credentialField(fieldId, field)) { issue('CREDENTIAL_FIELD_OMITTED', key); continue; }
                if (field && field.type === 'summary') {
                  if (source.hasSublistSubrecord({ sublistId, fieldId, line })) {
                    nested(fieldId, () => source.getSublistSubrecord({ sublistId, fieldId, line }), row.subrecords, key);
                  }
                } else capture(fieldId, () => source.getSublistValue({ sublistId, fieldId, line }), row.fields);
              } catch (error) {
                if (['GOVERNANCE_LIMIT', 'SSS_USAGE_LIMIT_EXCEEDED', 'RECORD_TOO_LARGE', 'RECORD_CELL_LIMIT'].includes(error.name)) throw error;
                issue('SUBLIST_VALUE_UNAVAILABLE', key);
              }
            }
            lines.push(row);
          }
          data.sublists[sublistId] = { lineCount: count, lines };
        } catch (error) {
          if (['GOVERNANCE_LIMIT', 'SSS_USAGE_LIMIT_EXCEEDED', 'RECORD_TOO_LARGE', 'RECORD_CELL_LIMIT'].includes(error.name)) throw error;
          issue('SUBLIST_UNAVAILABLE', sublistId);
        }
      }
      return data;
    }

    function exportRecords(request) {
      if (!EXPORT_TYPES.has(request.recordType)) fail('INVALID_RECORD_TYPE', 'Choose a supported SuperSuite export record type.');
      const pageSize = request.pageSize === undefined ? 5 : Number(request.pageSize);
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > LIMITS.maxRecordPageSize) {
        fail('INVALID_PAGE_SIZE', 'Record pageSize must be between 1 and 10.');
      }
      const cursor = request.cursor === undefined ? '0' : String(request.cursor);
      if (!/^\d{1,15}$/.test(cursor)) fail('INVALID_CURSOR', 'Use the nextCursor from the preceding records response.');
      // GROUP collapses transaction lines to one ID without excluding transaction
      // kinds whose mainline behaviour differs. Each new request resumes by ID.
      const column = search.createColumn({ name: 'internalid', summary: search.Summary.GROUP, sort: search.Sort.ASC });
      let rows;
      try {
        rows = search.create({ type: request.recordType,
          filters: [['internalidnumber', 'greaterthan', Number(cursor)]], columns: [column]
        }).run().getRange({ start: 0, end: pageSize + 1 });
      } catch (error) {
        if (/PERMISSION|ACCESS/i.test(String(error.name))) {
          fail('RECORD_PERMISSION_DENIED', 'Give the integration role View permission for this record type and check subsidiary restrictions.');
        }
        throw error;
      }
      const records = [];
      let responseBytes = RESPONSE_RESERVE;
      let lastId = cursor;
      for (const row of rows.slice(0, pageSize)) {
        const id = String(row.getValue(column));
        if (!/^\d{1,15}$/.test(id) || Number(id) <= Number(lastId)) fail('INVALID_SEARCH_RESULT', 'Record search returned an invalid or unsorted ID.');
        let result;
        try {
          checkUsage();
          const source = record.load({ type: request.recordType, id: Number(id), isDynamic: false });
          const budget = { bytes: 0, cells: 0, complete: true, issueCount: 0, issues: [] };
          const data = snapshot(source, budget, request.recordType + ':' + id, 0);
          result = { ok: true, id, recordType: request.recordType, ...data,
            complete: budget.complete, issues: budget.issues, issueCount: budget.issueCount };
          if (byteLength(JSON.stringify(result)) > LIMITS.maxRecordBytes) {
            fail('RECORD_TOO_LARGE', 'Record exceeds the 3 MiB export limit. Use a dedicated account export.');
          }
        } catch (error) {
          if (['GOVERNANCE_LIMIT', 'SSS_USAGE_LIMIT_EXCEEDED'].includes(error.name)) {
            if (!records.length) throw error;
            break; // Do not advance over this deferred ID.
          }
          const code = /PERMISSION|ACCESS/i.test(String(error.name)) ? 'RECORD_PERMISSION_DENIED' : String(error.name || 'RECORD_EXPORT_FAILED');
          // Platform messages can contain field values; return only a safe code.
          result = { ok: false, id, recordType: request.recordType, error: { code,
            message: code === 'RECORD_PERMISSION_DENIED' ? 'Check integration role View permission and subsidiary restrictions.' :
              'Record could not be exported. Check the error code and export limits.', retryable: false } };
        }
        const bytes = byteLength(JSON.stringify(result)) + 1;
        if (responseBytes + bytes > LIMITS.maxBatchBytes) break;
        responseBytes += bytes;
        records.push(result);
        lastId = id;
      }
      return { ok: true, recordType: request.recordType, records,
        nextCursor: rows.length > records.length ? lastId : null };
    }

    /** Inspection deliberately accepts data, never SuiteQL, formulas or code. */
    function inspectionType(value) {
      if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/.test(value) ||
        ['constructor', 'prototype', 'integration', 'accesstoken'].includes(value) || credentialField(value)) {
        fail('INVALID_RECORD_TYPE', 'Use a standard record type or customrecord script ID.');
      }
      return value;
    }

    function inspectionId(value, allowZero = false) {
      if (!['string', 'number'].includes(typeof value) ||
        !(allowZero ? /^(0|[1-9]\d{0,14})$/ : /^[1-9]\d{0,14}$/).test(String(value))) {
        fail(allowZero ? 'INVALID_CURSOR' : 'INVALID_RECORD_ID', 'Use a positive internal ID, or the returned search cursor.');
      }
      return String(value);
    }

    function inspectionField(value) {
      if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/.test(value) ||
        /^(formula|constructor$|prototype$)/i.test(value) || credentialField(value)) {
        fail('INVALID_FIELD_ID', 'Use a body field ID. Formulas, joins and credential fields are not supported.');
      }
      return value;
    }

    function inspectionArray(value, fallback) {
      if (value === undefined) return fallback;
      if (typeof value !== 'string' || byteLength(value) > 8192) {
        fail('INVALID_SEARCH', 'Search filters and columns must be JSON arrays of at most 8 KiB each.');
      }
      try {
        const decoded = JSON.parse(value);
        if (Array.isArray(decoded)) return decoded;
      } catch { /* Return the fixed error below; JSON text can contain private values. */ }
      fail('INVALID_SEARCH', 'Search filters and columns must be JSON arrays.');
    }

    // Platform exception messages may contain private field/filter values. Only
    // a bounded, recognizable error code and a fixed explanation cross the wire.
    function inspectionError(error) {
      const rawCode = String(error.name || error.code || 'RECORD_INSPECTION_FAILED');
      const code = /PERMISSION|ACCESS/i.test(rawCode) ? 'RECORD_PERMISSION_DENIED' :
        /^[A-Z][A-Z0-9_]{0,79}$/.test(rawCode) ? rawCode : 'RECORD_INSPECTION_FAILED';
      return { code, message: code === 'RECORD_PERMISSION_DENIED' ?
        'Check integration role View permissions, deployment audience and subsidiary restrictions.' :
        'Read-only inspection failed. Check the error code, record and field IDs, and request limits.',
      retryable: RETRYABLE.has(code) || code === 'SSS_USAGE_LIMIT_EXCEEDED' };
    }

    function inspectRecord(request) {
      const recordType = inspectionType(request.recordType);
      const id = inspectionId(request.internalId);
      const source = record.load({ type: recordType, id: Number(id), isDynamic: false });
      const budget = { bytes: 0, cells: 0, complete: true, issueCount: 0, issues: [] };
      const data = snapshot(source, budget, recordType + ':' + id, 0);
      const result = { ok: true, record: { id, recordType, ...data,
        complete: budget.complete, issues: budget.issues, issueCount: budget.issueCount } };
      if (byteLength(JSON.stringify(result)) > LIMITS.maxRecordBytes) fail('RECORD_TOO_LARGE', 'Record exceeds the inspection limit.');
      return result;
    }

    function searchFilters(request) {
      const raw = inspectionArray(request.filters, []);
      if (raw.length > 10) fail('INVALID_SEARCH', 'Use at most 10 AND filters.');
      return raw.map(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item) ||
          Object.keys(item).some(key => !['fieldId', 'operator', 'values'].includes(key))) {
          fail('INVALID_SEARCH', 'Use only fieldId, operator and values in each filter.');
        }
        const field = inspectionField(item.fieldId);
        if (!FILTER_OPERATORS.has(item.operator)) fail('INVALID_OPERATOR', 'Choose a supported search operator.');
        const values = item.values === undefined ? [] : item.values;
        if (!Array.isArray(values) || values.length > 20 || values.some(value =>
          typeof value === 'string' ? value.length > 500 || /[\x00-\x1f\x7f]/.test(value) :
            typeof value === 'number' ? !Number.isFinite(value) : typeof value !== 'boolean')) {
          fail('INVALID_FILTER_VALUES', 'Use at most 20 scalar values, each no longer than 500 characters.');
        }
        const count = values.length;
        const noValues = ['isempty', 'isnotempty'].includes(item.operator);
        const pair = ['within', 'between', 'notbetween'].includes(item.operator);
        const multiple = ['anyof', 'noneof'].includes(item.operator);
        if (noValues ? count !== 0 : pair ? count !== 2 : multiple ? count < 1 : count !== 1) {
          fail('INVALID_FILTER_VALUES', 'Supply the number of values required by the selected operator.');
        }
        return search.createFilter({ name: field, operator: item.operator, values });
      });
    }

    /**
     * Group IDs before loading selected body fields: transaction line matches
     * then yield one record, and deletions between pages do not shift offsets.
     * This is a live view, not a consistent account snapshot. Search-only types
     * may match but fail record.load; those failures remain explicit per result.
     */
    function inspectSearch(request) {
      const recordType = inspectionType(request.recordType);
      const cursor = inspectionId(request.cursor === undefined ? '0' : request.cursor, true);
      const pageSize = request.pageSize === undefined ? 5 : Number(request.pageSize);
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > LIMITS.maxRecordPageSize) {
        fail('INVALID_PAGE_SIZE', 'Search pageSize must be between 1 and 10.');
      }
      const rawColumns = inspectionArray(request.columns, ['internalid']);
      if (rawColumns.length < 1 || rawColumns.length > 20) fail('INVALID_SEARCH', 'Use between 1 and 20 body field IDs.');
      const columns = [...new Set(rawColumns.map(inspectionField))];
      const filters = searchFilters(request);
      filters.push(search.createFilter({ name: 'internalidnumber', operator: 'greaterthan', values: [Number(cursor)] }));
      const idColumn = search.createColumn({ name: 'internalid', summary: search.Summary.GROUP, sort: search.Sort.ASC });
      const rows = search.create({ type: recordType, filters, columns: [idColumn] }).run().getRange({ start: 0, end: pageSize + 1 });
      const results = [];
      let lastId = cursor;
      let bytes = RESPONSE_RESERVE;
      for (const row of rows.slice(0, pageSize)) {
        const id = inspectionId(row.getValue(idColumn));
        if (Number(id) <= Number(lastId)) fail('INVALID_SEARCH_RESULT', 'Search IDs must be unique and sorted.');
        let result;
        try {
          checkUsage();
          const fields = Object.create(null);
          const issues = [];
          const source = columns.some(field => field !== 'internalid') ?
            record.load({ type: recordType, id: Number(id), isDynamic: false }) : null;
          const available = source ? new Set(source.getFields()) : new Set();
          let fieldBytes = 0;
          for (const fieldId of columns) {
            if (fieldId === 'internalid') { fields.internalid = id; continue; }
            try {
              if (!available.has(fieldId)) { issues.push({ code: 'FIELD_UNAVAILABLE', fieldId }); continue; }
              const metadata = source.getField({ fieldId });
              if (credentialField(fieldId, metadata)) { issues.push({ code: 'CREDENTIAL_FIELD_OMITTED', fieldId }); continue; }
              if (metadata && metadata.type === 'summary') { issues.push({ code: 'SUBRECORD_REQUIRES_RECORD_INSPECTION', fieldId }); continue; }
              const value = source.getValue({ fieldId });
              const serialized = JSON.stringify(value);
              if (serialized === undefined) { issues.push({ code: 'VALUE_UNAVAILABLE', fieldId }); continue; }
              fieldBytes += byteLength(serialized) + byteLength(fieldId) + 12;
              if (fieldBytes > LIMITS.maxRecordBytes - RESPONSE_RESERVE) fail('RECORD_TOO_LARGE', 'Selected fields exceed the inspection limit.');
              fields[fieldId] = value;
            } catch (error) {
              if (['GOVERNANCE_LIMIT', 'SSS_USAGE_LIMIT_EXCEEDED', 'RECORD_TOO_LARGE'].includes(error.name)) throw error;
              issues.push({ code: 'FIELD_UNAVAILABLE', fieldId });
            }
          }
          result = { ok: true, id, recordType, fields, complete: issues.length === 0, issues };
        } catch (error) {
          if (['GOVERNANCE_LIMIT', 'SSS_USAGE_LIMIT_EXCEEDED'].includes(error.name)) {
            if (!results.length) throw error;
            break;
          }
          result = { ok: false, id, recordType, error: inspectionError(error) };
        }
        const resultBytes = byteLength(JSON.stringify(result)) + 1;
        if (bytes + resultBytes > LIMITS.maxBatchBytes) break;
        bytes += resultBytes;
        results.push(result);
        lastId = id;
      }
      return { ok: true, recordType, results, nextCursor: rows.length > results.length ? lastId : null };
    }

    function remove(request, ctx) {
      const path = scopedPath(request.path, ctx, true);
      let source;
      try { source = loadFile(path); } catch (error) {
        if (error.name === 'RCRD_DSNT_EXIST') return { ok: true, path, deleted: false };
        throw error;
      }
      file.delete({ id: source.id });
      return { ok: true, path, deleted: true };
    }

    /** Keep application errors in one stable, credential-free envelope. */
    function dispatch(request, method) {
      try {
        if (!request || typeof request !== 'object' || Array.isArray(request)) {
          fail('INVALID_REQUEST', 'Send a JSON object with an action.');
        }
        if (byteLength(JSON.stringify(request)) > LIMITS.maxBatchBytes) {
          fail('REQUEST_TOO_LARGE', 'Reduce the batch size or encoded file size.');
        }
        const action = request.action || (request.type === 'version' ? 'version' : '');
        if (action === 'version' && method !== 'DELETE') {
          const currentUser = runtime.getCurrentUser();
          return { ok: true, protocolVersion: 2, restletVersion: VERSION, limits: LIMITS,
            capabilities: { recordExport: true, readOnlyInspection: true }, readOnlyMode: readOnlyMode(),
            identity: { accountId: String(runtime.accountId), userId: String(currentUser.id), roleId: String(currentUser.role) } };
        }
        const ctx = context();
        if (readOnlyMode() && (action === 'push' || action === 'delete')) {
          fail('READ_ONLY_DEPLOYMENT', 'This deployment allows read-only access. Use a separate deployment for file changes.');
        }
        checkUsage();
        if (action === 'list' && method !== 'DELETE') return list(request, ctx);
        if (action === 'metadata' && method !== 'DELETE') return metadata(request);
        if (action === 'records' && method === 'GET') return exportRecords(request);
        if (action === 'record' && method === 'GET') return inspectRecord(request);
        if (action === 'search' && method === 'GET') return inspectSearch(request);
        if (action === 'pull' && method === 'POST') return batch(request, ctx, false);
        if (action === 'push' && method === 'POST') return batch(request, ctx, true);
        if (action === 'delete' && method === 'DELETE') return remove(request, ctx);
        fail('UNSUPPORTED_ACTION', 'Use version, list, metadata, GET records/record/search, POST pull/push, or DELETE delete.');
      } catch (error) {
        if (request && ['record', 'search'].includes(request.action)) return { ok: false, error: inspectionError(error) };
        return { ok: false, error: errorDetails(error) };
      }
    }

    return { get: request => dispatch(request, 'GET'), post: request => dispatch(request, 'POST'),
      delete: request => dispatch(request, 'DELETE') };
  });
