const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const Database = require('better-sqlite3');

const source = readFileSync(join(__dirname, '../pages/api/runs/[id]/enroll.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

function fixture(t, beforeLock) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE runs (id TEXT PRIMARY KEY, workflow_id TEXT, status TEXT);
    CREATE TABLE workflow_steps (workflow_id TEXT, track TEXT);
    CREATE TABLE targets (id TEXT PRIMARY KEY, company_id TEXT);
    CREATE TABLE run_profiles (
      id TEXT PRIMARY KEY, run_id TEXT REFERENCES runs(id),
      target_id TEXT REFERENCES targets(id), email_account_id TEXT
    );
    CREATE TABLE run_profile_tracks (
      id TEXT PRIMARY KEY, run_profile_id TEXT REFERENCES run_profiles(id),
      track TEXT, state TEXT, current_step INTEGER
    );
    INSERT INTO runs VALUES ('run', 'workflow', 'paused');
    INSERT INTO targets VALUES ('alice', NULL), ('bob', NULL);
    INSERT INTO workflow_steps VALUES ('workflow', 'linkedin');
  `);
  // Simulate a competing writer committing after the handler's preview reads.
  const transaction = db.transaction.bind(db);
  db.transaction = (fn) => {
    const tx = transaction(fn);
    return {
      immediate(...args) {
        if (beforeLock) beforeLock(db);
        return tx.immediate(...args);
      },
    };
  };
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require: (id) => id === '@/lib/db' ? { getDb: () => db } : require(id),
  });
  function request(body, method = 'POST') {
    const response = {
      statusCode: 200, headers: {}, body: undefined,
      status(code) { this.statusCode = code; return this; },
      setHeader(key, value) { this.headers[key] = value; },
      json(value) { this.body = JSON.parse(JSON.stringify(value)); return this; },
      end() { return this; },
    };
    exports.default({ method, query: { id: 'run' }, body }, response);
    return response;
  }
  const count = () => db.prepare('SELECT COUNT(*) AS n FROM run_profiles').get().n;
  return { db, request, count };
}

function enrollElsewhere(db, workflow = 'workflow') {
  db.prepare('INSERT INTO runs VALUES (?, ?, ?)').run('other', workflow, 'running');
  db.exec(`
    INSERT INTO run_profiles VALUES ('existing', 'other', 'alice', NULL);
    INSERT INTO run_profile_tracks VALUES ('existing-track', 'existing', 'linkedin', 'pending', 0);
  `);
}

test('advertises the guard and allowed methods without enrollment', (t) => {
  const { request, count } = fixture(t);
  assert.deepEqual(request(undefined, 'GET').body, { expectedStatusGuard: true });
  const result = request(undefined, 'DELETE');
  assert.equal(result.statusCode, 405);
  assert.deepEqual(Array.from(result.headers.Allow), ['GET', 'POST']);
  assert.equal(count(), 0);
});

test('rejects invalid expected status before writing', (t) => {
  const { request, count } = fixture(t);
  assert.equal(request({ target_ids: ['alice'], expected_status: 'completed' }).statusCode, 400);
  assert.equal(count(), 0);
});

test('enrolls unique targets and creates their tracks once', (t) => {
  const { request, db, count } = fixture(t);
  const body = { target_ids: ['alice', 'alice', 'bob'], expected_status: 'paused' };
  assert.equal(request(body).body.enrolled, 2);
  assert.equal(count(), 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM run_profile_tracks').get().n, 2);
  assert.deepEqual(request(body).body, {
    enrolled: 0, skipped_already_enrolled: 2, skipped_active_elsewhere: 0,
  });
});

test('keeps clients without expected_status compatible', (t) => {
  const { request } = fixture(t);
  assert.equal(request({ target_ids: ['alice'] }).body.enrolled, 1);
});

for (const status of ['pending', 'paused', 'running']) {
  test(`accepts matching ${status} state`, (t) => {
    const { request, db } = fixture(t);
    db.prepare('UPDATE runs SET status = ?').run(status);
    assert.equal(request({ target_ids: ['alice'], expected_status: status }).body.enrolled, 1);
  });
}

test('rejects a state change after preview, without partial enrollment', (t) => {
  const { request, count } = fixture(t, (db) => db.exec("UPDATE runs SET status = 'running'"));
  const result = request({ target_ids: ['alice', 'bob'], expected_status: 'paused' });
  assert.equal(result.statusCode, 409);
  assert.deepEqual(result.body, { error: 'run_status_changed' });
  assert.equal(count(), 0);
});

test('rechecks workflow duplicates after preview and reports actual inserts', (t) => {
  const { request, count } = fixture(t, (db) => enrollElsewhere(db));
  assert.deepEqual(request({ target_ids: ['alice', 'bob'], expected_status: 'paused' }).body, {
    enrolled: 1, skipped_already_enrolled: 1, skipped_active_elsewhere: 0,
  });
  assert.equal(count(), 2);
});

test('rechecks active enrollment in another workflow after preview', (t) => {
  const { request, count } = fixture(t, (db) => enrollElsewhere(db, 'another-workflow'));
  assert.deepEqual(request({ target_ids: ['alice', 'bob'], expected_status: 'paused' }).body, {
    enrolled: 1, skipped_already_enrolled: 0, skipped_active_elsewhere: 1,
  });
  assert.equal(count(), 2);
});

test('rolls back the batch if insertion fails', (t) => {
  const { request, count, db } = fixture(t);
  assert.throws(() => request({ target_ids: ['alice', 'missing'], expected_status: 'paused' }), /FOREIGN KEY/);
  assert.equal(count(), 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM run_profile_tracks').get().n, 0);
});
