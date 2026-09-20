const fs = require('fs'), ts = require('typescript'), Module = require('module'), assert = require('node:assert/strict'), DB = require('better-sqlite3');
(async () => {
    let passed = 0;
    for (const [failure, header] of [[false, '١٬٠٠٢ connections'], [false, null], [true, '١٬٠٠٢ connections']]) {
        const db = new DB(':memory:');
        db.exec(`CREATE TABLE accounts(id TEXT,connections_synced_through_ms INTEGER,accepted_sync_at TEXT,li_connections INTEGER);INSERT INTO accounts(id,connections_synced_through_ms) VALUES('a',1900000000000);CREATE TABLE targets(id TEXT,linkedin_url TEXT,connection_requested_at TEXT,connected_at TEXT,degree INTEGER);CREATE TABLE runs(id TEXT,account_id TEXT);CREATE TABLE run_profiles(target_id TEXT,run_id TEXT);INSERT INTO runs VALUES('r','a'),('other','b');INSERT INTO targets VALUES('match','https://www.linkedin.com/in/synthetic-person', 'sent',NULL,NULL),('foreign','https://www.linkedin.com/in/synthetic-person/','sent',NULL,NULL),('absent','https://www.linkedin.com/in/absent/','sent',NULL,NULL);INSERT INTO run_profiles VALUES('match','r'),('foreign','other'),('absent','r');`);
        db.exec("UPDATE accounts SET li_connections=99; INSERT INTO targets VALUES('previous','https://www.linkedin.com/in/previous/','sent','2020-01-01',1); INSERT INTO run_profiles VALUES('previous','r')");
        let pages = 0;
        const page = { goto: async () => { }, waitForTimeout: async () => { }, url: () => 'https://www.linkedin.com/mynetwork/invite-connect/connections/', close: async () => { }, evaluate: async (fn, args) => !args ? null : failure ? null : pages++ === 0 ? [{ vanity: 'unrelated', createdAt: 1789751000000 }] : pages === 2 ? [{ vanity: 'synthetic-person', createdAt: 1658235047000 }] : [] };
        page.locator = selector => {
            assert.equal(selector, '[componentkey="ConnectionsPage_ConnectionsListHeader"] p');
            return { first: () => ({ textContent: async () => header }) };
        };
        const m = new Module('/app/sync-fixture.cjs');
        m.require = n => n === '@/lib/linkedin/counts' ? require('./load-linkedin.cjs').loadLinkedIn('counts') : n === '@/lib/db' ? { getDb: () => db } : n === '@/lib/linkedin/session' ? { getSessionPage: async () => page, saveSessionState: async () => { }, markNeedsReauth: async () => { } } : require(n);
        m._compile(ts.transpileModule(fs.readFileSync(require('path').join(__dirname, '../lib/linkedin/sync-accepted.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, '/app/sync-fixture.cjs');
        assert.equal(m.exports.profileVanity('https://www.linkedin.com/in/Synthetic-person/?x=y'), 'synthetic-person');
        assert.equal(m.exports.profileVanity('https://evil.test/in/synthetic-person'), null);
        passed += 2;
        if (failure) {
            await assert.rejects(m.exports.syncAcceptedConnections('a'), /unavailable/);
            assert.equal(db.prepare('SELECT accepted_sync_at FROM accounts').get().accepted_sync_at, null);
            assert.equal(db.prepare('SELECT li_connections FROM accounts').get().li_connections, 99);
            passed += 3;
        }
        else {
            assert.equal(await m.exports.syncAcceptedConnections('a'), 1);
            assert.equal(db.prepare("SELECT degree FROM targets WHERE id='match'").get().degree, 1);
            assert.equal(db.prepare("SELECT degree FROM targets WHERE id='foreign'").get().degree, null);
            assert.equal(db.prepare("SELECT degree FROM targets WHERE id='absent'").get().degree, null);
            passed += 4;
            assert.equal(db.prepare("SELECT connected_at FROM targets WHERE id='match'").get().connected_at, '2022-07-19 12:50:47');
            assert.ok(db.prepare('SELECT accepted_sync_at FROM accounts').get().accepted_sync_at);
            pages = 0;
            assert.equal(await m.exports.syncAcceptedConnections('a'), 0);
            assert.equal(db.prepare('SELECT li_connections FROM accounts').get().li_connections, header === null ? 99 : 1002);
            assert.equal(db.prepare("SELECT degree FROM targets WHERE id='previous'").get().degree, 1);
            passed += 5;
        }
        db.close();
    }
    console.log(JSON.stringify({ passed, network: 'none', synthetic: true }));
})().catch(e => { console.error(e); process.exitCode = 1; });
