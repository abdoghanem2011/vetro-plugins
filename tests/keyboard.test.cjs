'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('node:fs');
var net = require('node:net');
var os = require('node:os');
var path = require('node:path');
var stream = require('node:stream');

var pluginFactory = require('../plugins/keyboard/index.js');

function createTempFiles(t) {
    var root = fs.mkdtempSync(path.join(os.tmpdir(), 'vetro-kbd-test-'));
    var arpFile = path.join(root, 'arp');
    var inputFile = path.join(root, 'devices');
    fs.writeFileSync(arpFile, [
        'IP address       HW type     Flags       HW address            Mask     Device',
        '192.168.1.10     0x1         0x2         aa:bb:cc:dd:ee:01     *        wlan0',
        '192.168.1.20     0x1         0x2         aa:bb:cc:dd:ee:02     *        wlan0',
        '192.168.1.30     0x1         0x0         00:00:00:00:00:00     *        wlan0'
    ].join('\n') + '\n', 'utf8');
    fs.writeFileSync(inputFile, [
        'I: Bus=0003 Vendor=04e8 Product=1234 Version=0100',
        'N: Name="Remote-Input(Mouse)"',
        'H: Handlers=mouse0 event3',
        '',
        'I: Bus=0003 Vendor=0001 Product=0002 Version=0100',
        'N: Name="Other Mouse"',
        'H: Handlers=mouse1 event5',
        ''
    ].join('\n'), 'utf8');
    if (t && typeof t.after === 'function') {
        t.after(function () {
            try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
        });
    }
    return { root: root, arpFile: arpFile, inputFile: inputFile };
}

function createPluginHarness(t, opts) {
    opts = opts || {};
    var files = opts.files || createTempFiles(t);
    var cfgData = opts.initialConfig ? JSON.parse(JSON.stringify(opts.initialConfig)) : {};
    var execLog = [];
    var configWrites = 0;

    var ctx = {
        id: 'keyboard',
        dir: files.root,
        _arpPath: files.arpFile,
        _inputDevicesPath: files.inputFile,
        config: {
            get: function () { return cfgData; },
            set: function (val) {
                configWrites++;
                cfgData = JSON.parse(JSON.stringify(val));
            }
        },
        execute: function (cmd, timeoutMs) {
            execLog.push({ cmd: cmd, timeoutMs: timeoutMs });
            if (typeof opts.onExecute === 'function') {
                return Promise.resolve(opts.onExecute(cmd, timeoutMs, execLog));
            }
            return Promise.resolve({ exit_code: 0, stdout: '', stderr: '' });
        }
    };

    var p = pluginFactory(ctx);
    p.start();
    if (t && typeof t.after === 'function') {
        t.after(function () {
            try { p.stop(); } catch (e) {}
        });
    }

    return {
        plugin: p,
        ctx: ctx,
        files: files,
        execLog: execLog,
        getConfig: function () { return cfgData; },
        getConfigWrites: function () { return configWrites; }
    };
}

function invokeRoute(plugin, opts) {
    return new Promise(function (resolve) {
        var req = new stream.PassThrough();
        req.method = opts.method || 'GET';
        req.url = opts.url || ('/' + opts.sub);
        req.headers = opts.headers || {};
        req.socket = { remoteAddress: opts.remoteAddress || '::ffff:192.168.1.10' };

        var statusCode = 200;
        var resHeaders = {};
        var chunks = [];
        var finished = false;
        var listeners = { finish: [], close: [] };

        var res = {
            headersSent: false,
            writableEnded: false,
            finished: false,
            writeHead: function (code, hdrs) {
                statusCode = code;
                this.headersSent = true;
                if (hdrs) {
                    var ks = Object.keys(hdrs);
                    for (var i = 0; i < ks.length; i++) {
                        resHeaders[ks[i].toLowerCase()] = hdrs[ks[i]];
                    }
                }
            },
            setHeader: function (k, v) { resHeaders[String(k).toLowerCase()] = v; },
            write: function (chunk) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); return true; },
            once: function (ev, fn) { if (listeners[ev]) listeners[ev].push(fn); },
            on: function (ev, fn) { if (listeners[ev]) listeners[ev].push(fn); },
            removeListener: function () {},
            emit: function () {},
            end: function (chunk) {
                if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
                if (finished) return;
                finished = true;
                this.writableEnded = true;
                this.finished = true;
                var fl = listeners.finish.slice();
                for (var fi = 0; fi < fl.length; fi++) fl[fi]();
                var raw = Buffer.concat(chunks).toString('utf8');
                var json = null;
                try { json = JSON.parse(raw); } catch (e) {}
                resolve({ handled: true, status: statusCode, headers: resHeaders, body: raw, json: json });
            }
        };

        var handled = plugin.route(req, res, opts.sub);
        if (!handled) {
            resolve({ handled: false, status: 404, headers: resHeaders, body: '', json: null });
            return;
        }

        if (opts.body !== undefined) {
            process.nextTick(function () {
                var buf = Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
                req.end(buf);
            });
        } else if (req.method === 'POST') {
            process.nextTick(function () { req.end(); });
        }
    });
}

function createStreamViewer(plugin) {
    var req = new stream.PassThrough();
    req.method = 'GET';
    req.url = '/stream';
    req.headers = {};
    req.socket = { remoteAddress: '::ffff:192.168.1.10' };

    var chunks = [];
    var ended = false;
    var statusCode = null;
    var headers = {};
    var closeHandlers = [];

    var res = {
        headersSent: false,
        finished: false,
        socket: {
            writable: true,
            bufferSize: 0,
            setNoDelay: function () {},
            destroy: function () { this.writable = false; }
        },
        writeHead: function (code, hdrs) {
            statusCode = code;
            this.headersSent = true;
            if (hdrs) {
                var ks = Object.keys(hdrs);
                for (var i = 0; i < ks.length; i++) {
                    headers[ks[i].toLowerCase()] = hdrs[ks[i]];
                }
            }
        },
        write: function (chunk, cb) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
            if (typeof cb === 'function') cb();
            return true;
        },
        on: function (ev, fn) {
            if (ev === 'close') closeHandlers.push(fn);
        },
        end: function (chunk) {
            if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
            ended = true;
            this.finished = true;
        }
    };

    var handled = plugin.route(req, res, 'stream');
    return {
        handled: handled,
        req: req,
        res: res,
        disconnect: function () { req.emit('close'); },
        getStatus: function () { return statusCode; },
        getHeaders: function () { return headers; },
        getData: function () { return Buffer.concat(chunks); },
        isEnded: function () { return ended; }
    };
}

function connectProducer(port) {
    return new Promise(function (resolve, reject) {
        var sock = net.connect(port, '127.0.0.1', function () { resolve(sock); });
        sock.on('error', reject);
    });
}

function extractStreamPort(cmd) {
    var m = /tcpclientsink host=127\.0\.0\.1 port=(\d+)/.exec(cmd || '');
    return m ? parseInt(m[1], 10) : 0;
}

function waitUntil(fn, timeoutMs) {
    var deadline = Date.now() + (timeoutMs || 2000);
    return new Promise(function (resolve, reject) {
        function step() {
            var val = fn();
            if (val) return resolve(val);
            if (Date.now() > deadline) return reject(new Error('waitUntil timed out'));
            setTimeout(step, 10);
        }
        step();
    });
}

// ==================== 1. STREAM STATE MACHINE ====================

test('stream pipeline serves MJPEG frames, caps viewers at 4, recovers on 1 drop, and handles listen() disconnect race', async function (t) {
    var launches = [];
    var stops = 0;
    var failNextLaunch = false;
    var h = createPluginHarness(t, {
        onExecute: function (cmd) {
            if (cmd.indexOf('gst-launch-1.0') >= 0) {
                launches.push(cmd);
                if (failNextLaunch) {
                    failNextLaunch = false;
                    return { exit_code: 1, stdout: '', stderr: 'gst failed' };
                }
            } else if (cmd.indexOf('rm -f /tmp/vetro-keyboard-stream.pid') >= 0) {
                stops++;
            }
            return { exit_code: 0, stdout: '', stderr: '' };
        }
    });

    // A. Disconnect-before-listen() race: connect v0 and immediately close req BEFORE srv.listen returns
    var vRace = createStreamViewer(h.plugin);
    assert.equal(vRace.handled, true);
    assert.equal(vRace.getStatus(), 200);
    vRace.disconnect();

    await new Promise(function (r) { setTimeout(r, 40); });
    assert.equal(launches.length, 0, 'cancelled viewer must not launch gst-launch-1.0');

    // Connecting a new viewer after the cancelled listen() must cleanly recover and bind a new port
    var v1 = createStreamViewer(h.plugin);
    assert.equal(v1.getStatus(), 200);
    await waitUntil(function () { return launches.length === 1; });
    var port1 = extractStreamPort(launches[0]);
    assert.ok(port1 > 0, 'expected ephemeral loopback port > 0');

    var prod1 = await connectProducer(port1);
    t.after(function () { try { prod1.destroy(); } catch (e) {} });

    var jpeg1 = Buffer.from([0xFF, 0xD8, 0x01, 0x02, 0x03, 0xFF, 0xD9]);
    prod1.write(jpeg1);
    await waitUntil(function () { return v1.getData().indexOf(jpeg1) >= 0; });
    var out1 = v1.getData();
    assert.ok(out1.toString('ascii').indexOf('--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ' + jpeg1.length) >= 0);

    // B. Cap at MAX_STREAM_CLIENTS = 4 (5th viewer gets 503)
    var v2 = createStreamViewer(h.plugin);
    var v3 = createStreamViewer(h.plugin);
    var v4 = createStreamViewer(h.plugin);
    var v5 = createStreamViewer(h.plugin);
    assert.equal(v2.getStatus(), 200);
    assert.equal(v3.getStatus(), 200);
    assert.equal(v4.getStatus(), 200);
    assert.equal(v5.getStatus(), 503);
    assert.equal(v5.json ? v5.json.error : JSON.parse(v5.getData().toString('utf8')).error, 'too many stream viewers');

    // C. Invalid stream_preset returns 400; valid preset persists & triggers restart while viewers active
    var badPreset = await invokeRoute(h.plugin, { method: 'POST', sub: 'stream_preset', body: { preset: 'ultra', quality: 'bad' } });
    assert.equal(badPreset.status, 400);

    var launchesBeforePreset = launches.length;
    var okPreset = await invokeRoute(h.plugin, { method: 'POST', sub: 'stream_preset', body: { preset: 'hd', quality: 80 } });
    assert.equal(okPreset.status, 200);
    assert.equal(okPreset.json.preset, 'hd');
    assert.equal(okPreset.json.width, 1280);
    assert.equal(okPreset.json.height, 720);
    assert.equal(okPreset.json.quality, 80);
    assert.equal(h.getConfig().streamPreset, 'hd');
    assert.equal(h.getConfig().streamQuality, 80);

    await waitUntil(function () { return launches.length > launchesBeforePreset; });
    var restartCmd = launches[launches.length - 1];
    assert.ok(restartCmd.indexOf('width=1280,height=720') >= 0);
    assert.ok(restartCmd.indexOf('quality=80') >= 0);

    // D. Producer disconnect recovery: 1st unexpected drop restarts (restores pipeline); failing launch closes viewers
    var portAfterPreset = extractStreamPort(restartCmd);
    var prod2 = await connectProducer(portAfterPreset);
    t.after(function () { try { prod2.destroy(); } catch (e) {} });
    await new Promise(function (r) { setTimeout(r, 30); });

    var launchesBeforeDrop = launches.length;
    prod2.destroy();
    await waitUntil(function () { return launches.length > launchesBeforeDrop; });
    assert.equal(v1.isEnded(), false, 'first producer drop should restart instead of closing viewers');

    // Trigger another preset restart whose launch fails with exit_code: 1 -> closes all viewers & stops pipeline
    failNextLaunch = true;
    var failPreset = await invokeRoute(h.plugin, { method: 'POST', sub: 'stream_preset', body: { preset: 'fast', quality: 45 } });
    assert.equal(failPreset.status, 200);
    await waitUntil(function () { return v1.isEnded() && v2.isEnded() && v3.isEnded() && v4.isEnded(); });
    assert.ok(stops >= 1);
});

// ==================== 2. PER-DEVICE PAIRING ISOLATION ====================

test('per-device pairing isolates tokens via salted ARP HMAC, migrates legacy token, and enforces 16-device LRU cap', async function (t) {
    var h = createPluginHarness(t, {
        initialConfig: { token: 'legacy-tok-000' }
    });

    // Legacy single token migrates transparently on first read when tokens map is empty
    var legRes = await invokeRoute(h.plugin, { method: 'GET', sub: 'token', remoteAddress: '::ffff:192.168.1.10' });
    assert.equal(legRes.status, 200);
    assert.equal(legRes.json.token, 'legacy-tok-000');
    assert.equal(legRes.json.legacy, true);
    assert.ok(legRes.json.deviceTag);

    // Device A saves its own token -> clears legacy token, isolates Device B
    var saveA = await invokeRoute(h.plugin, {
        method: 'POST',
        sub: 'savetoken',
        remoteAddress: '::ffff:192.168.1.10',
        body: { token: 'tok-device-A' }
    });
    assert.equal(saveA.status, 200);
    assert.equal(h.getConfig().token, undefined);

    var tokA = await invokeRoute(h.plugin, { method: 'GET', sub: 'token', remoteAddress: '::ffff:192.168.1.10' });
    var tokB = await invokeRoute(h.plugin, { method: 'GET', sub: 'token', remoteAddress: '::ffff:192.168.1.20' });
    assert.equal(tokA.json.token, 'tok-device-A');
    assert.equal(tokB.json.token, null, 'unpaired Device B must receive null');
    assert.notEqual(tokA.json.deviceTag, tokB.json.deviceTag);

    // Config JSON must never store raw MAC addresses or client IPs
    var rawCfgStr = JSON.stringify(h.getConfig());
    assert.equal(rawCfgStr.indexOf('aa:bb:cc:dd:ee:01'), -1);
    assert.equal(rawCfgStr.indexOf('192.168.1.10'), -1);

    // Device B saves its own token -> both devices coexist & status() hides raw tokens
    var saveB = await invokeRoute(h.plugin, {
        method: 'POST',
        sub: 'savetoken',
        remoteAddress: '::ffff:192.168.1.20',
        body: { token: 'tok-device-B' }
    });
    assert.equal(saveB.status, 200);

    var tokAAgain = await invokeRoute(h.plugin, { method: 'GET', sub: 'token', remoteAddress: '::ffff:192.168.1.10' });
    var tokBAgain = await invokeRoute(h.plugin, { method: 'GET', sub: 'token', remoteAddress: '::ffff:192.168.1.20' });
    assert.equal(tokAAgain.json.token, 'tok-device-A');
    assert.equal(tokBAgain.json.token, 'tok-device-B');

    assert.deepEqual(h.plugin.status(), { paired: true });
    var statusB = await invokeRoute(h.plugin, { method: 'GET', sub: 'status', remoteAddress: '::ffff:192.168.1.20' });
    assert.equal(statusB.json.paired, true);
    assert.equal(JSON.stringify(statusB.json).indexOf('tok-device-B'), -1);

    // Device A reset deletes only Device A while preserving Device B
    var resetA = await invokeRoute(h.plugin, {
        method: 'POST',
        sub: 'savetoken',
        remoteAddress: '::ffff:192.168.1.10',
        body: { reset: true }
    });
    assert.equal(resetA.status, 200);
    var afterResetA = await invokeRoute(h.plugin, { method: 'GET', sub: 'token', remoteAddress: '::ffff:192.168.1.10' });
    var afterResetB = await invokeRoute(h.plugin, { method: 'GET', sub: 'token', remoteAddress: '::ffff:192.168.1.20' });
    assert.equal(afterResetA.json.token, null);
    assert.equal(afterResetB.json.token, 'tok-device-B');

    // Enforce 16-device LRU cap (192.168.1.20 already present, save 16 new IPs -> total 16, oldest .20 evicted)
    for (var i = 100; i < 116; i++) {
        var sr = await invokeRoute(h.plugin, {
            method: 'POST',
            sub: 'savetoken',
            remoteAddress: '10.0.0.' + i,
            body: { token: 'tok-' + i }
        });
        assert.equal(sr.status, 200);
    }
    assert.equal(Object.keys(h.getConfig().tokens).length, 16);
    var evictedB = await invokeRoute(h.plugin, { method: 'GET', sub: 'token', remoteAddress: '::ffff:192.168.1.20' });
    assert.equal(evictedB.json.token, null, 'oldest device slot must be evicted past MAX_TOKEN_DEVICES=16');
});

// ==================== 3. MOUSE NODE CACHING ====================

test('findMouseNode caches device node across mouse requests and invalidates on command failure or stop()', async function (t) {
    var failNextMouse = false;
    var mouseCmds = [];
    var h = createPluginHarness(t, {
        onExecute: function (cmd) {
            if (cmd.indexOf('mousegen') >= 0 || cmd.indexOf('init_device') >= 0) {
                mouseCmds.push(cmd);
                if (failNextMouse) {
                    failNextMouse = false;
                    return { exit_code: 1, stdout: '', stderr: 'device gone' };
                }
            }
            return { exit_code: 0, stdout: '', stderr: '' };
        }
    });

    // 1. First mouse request reads /proc/bus/input/devices -> event3
    var m1 = await invokeRoute(h.plugin, { method: 'POST', sub: 'mouse', body: { action: 'click', x: 100, y: 200 } });
    assert.equal(m1.status, 200);
    assert.equal(m1.json.ok, true);
    assert.ok(mouseCmds[0].indexOf('/dev/input/event3') >= 0);

    // Rewrite devices file -> event7 while cache is warm; failed/non-init isn't invalidated yet so cache still serves event3
    fs.writeFileSync(h.files.inputFile, [
        'I: Bus=0003 Vendor=04e8 Product=1234 Version=0100',
        'N: Name="Remote-Input(Mouse)"',
        'H: Handlers=mouse0 event7',
        ''
    ].join('\n'), 'utf8');

    // Simulate a command failure -> invalidates cachedMouseNode (after returning ok: false on event3)
    failNextMouse = true;
    var m2 = await invokeRoute(h.plugin, { method: 'POST', sub: 'mouse', body: { action: 'click', x: 120, y: 220 } });
    assert.equal(m2.json.ok, false);

    // 3. Next mouse request re-reads /proc/bus/input/devices and picks up event7!
    var m3 = await invokeRoute(h.plugin, { method: 'POST', sub: 'mouse', body: { action: 'click', x: 130, y: 230 } });
    assert.equal(m3.json.ok, true);
    assert.ok(mouseCmds[mouseCmds.length - 1].indexOf('/dev/input/event7') >= 0);

    // Verify warm cache avoids stale re-read until stop(): rewrite to event9 and confirm click still runs cleanly
    fs.writeFileSync(h.files.inputFile, [
        'I: Bus=0003 Vendor=04e8 Product=1234 Version=0100',
        'N: Name="Remote-Input(Mouse)"',
        'H: Handlers=mouse0 event9',
        ''
    ].join('\n'), 'utf8');
    // Force init_device on next click by waiting for nothing? Wait: mouseInitNode is event7 so click skips init_device;
    // verify stop() + start() clears cachedMouseNode so next request after restart resolves event9!
    h.plugin.stop();
    h.plugin.start();
    var m4 = await invokeRoute(h.plugin, { method: 'POST', sub: 'mouse', body: { action: 'click', x: 140, y: 240 } });
    assert.equal(m4.json.ok, true);
    assert.ok(mouseCmds[mouseCmds.length - 1].indexOf('/dev/input/event9') >= 0);
});
