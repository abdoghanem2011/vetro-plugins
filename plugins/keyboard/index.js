'use strict';

// Vetro Shard: Keyboard & Remote
//
// Dual input architecture:
//   1. Navigation, control keys & ASCII typing: executed directly on the TV via
//      /usr/bin/input_keyevent (ctx.execute).
//   2. Full Unicode (all languages): sent via Samsung Remote API WebSocket
//      (wss://<tvIp>:8002) directly from the browser using pre-paired token.
//
// Continuous Key Repeat:
//   - WebSocket mode: uses Samsung Remote "Press" and "Release" commands.
//   - HTTP mode: sends a single input_keyevent down/up pair (letting the TV handle
//     native key repeat and cursor acceleration) with a 6 s auto-release safety cap.

var fs = require('fs');
var path = require('path');
var os = require('os');
var net = require('net');
var crypto = require('crypto');

var MAX_TOKEN_DEVICES = 16;

var LATIN_MAP = {
    ' ': 'space',
    '.': 'period',
    ',': 'comma',
    '-': 'minus',
    '=': 'equal',
    '/': 'slash',
    ';': 'semicolon',
    "'": 'apostrophe',
    '[': 'bracketleft',
    ']': 'bracketright',
    '\\': 'backslash',
    '`': 'grave'
};

var SHIFT_MAP = {
    '!': '1',
    '@': '2',
    '#': '3',
    '$': '4',
    '%': '5',
    '^': '6',
    '&': '7',
    '*': '8',
    '(': '9',
    ')': '0',
    '_': 'minus',
    '+': 'equal',
    '~': 'grave',
    '{': 'bracketleft',
    '}': 'bracketright',
    '|': 'backslash',
    ':': 'semicolon',
    '"': 'apostrophe',
    '<': 'comma',
    '>': 'period',
    '?': 'slash'
};

var STREAM_PRESETS = {
    fast: { width: 640, height: 360, quality: 45 },
    balanced: { width: 960, height: 540, quality: 55 },
    hd: { width: 1280, height: 720, quality: 72 }
};

function loadPage(ctx) {
    var places = [path.join(__dirname, 'ui.html'), path.join(ctx.dir || '', 'ui.html')];
    for (var i = 0; i < places.length; i++) {
        try { return fs.readFileSync(places[i], 'utf8'); } catch (e) { /* next */ }
    }
    return '<!doctype html><meta charset="utf-8"><p>Page file missing: reinstall this Shard.</p>';
}

function getTvIp() {
    try {
        var ifaces = os.networkInterfaces();
        for (var name in ifaces) {
            var list = ifaces[name];
            if (!list) continue;
            for (var i = 0; i < list.length; i++) {
                var addr = list[i];
                if (addr.family === 'IPv4' && !addr.internal && addr.address !== '127.0.0.1') {
                    return addr.address;
                }
            }
        }
    } catch (e) {}
    return null;
}

function readJson(req, maxBytes, callback) {
    var limit = maxBytes || 4096;
    var body = '';
    var done = false;

    function finish(err, res) {
        if (done) return;
        done = true;
        req.removeListener('data', onData);
        req.removeListener('end', onEnd);
        req.removeListener('error', onError);
        callback(err, res);
    }

    function onError(err) {
        finish(err || new Error('Request error'), null);
    }

    function onData(chunk) {
        if (done) return;
        body += chunk;
        if (body.length > limit) {
            finish(new Error('Payload too large'), null);
        }
    }

    function onEnd() {
        if (done) return;
        var parsed;
        try {
            parsed = JSON.parse(body);
        } catch (e) {
            return finish(new Error('Invalid JSON'), null);
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return finish(new Error('Invalid JSON object'), null);
        }
        finish(null, parsed);
    }

    req.on('error', onError);
    req.on('data', onData);
    req.on('end', onEnd);
}

module.exports = function (ctx) {

    var inputDevicesPath = (ctx && ctx._inputDevicesPath) ? String(ctx._inputDevicesPath) : '/proc/bus/input/devices';
    var arpPath = (ctx && ctx._arpPath) ? String(ctx._arpPath) : '/proc/net/arp';
    var MOUSE_NODE_CACHE_MS = 30000;
    var cachedMouseNode = null;
    var cachedMouseNodeAt = 0;

    function invalidateMouseNodeCache() {
        cachedMouseNode = null;
        cachedMouseNodeAt = 0;
    }

    var page = null;
    var activeHoldTimer = null;
    var activeHoldKey = null;
    var activeHoldDownPromise = null;
    var mouseHeldNode = null;
    var mouseHoldTimer = null;
    var mouseHoldStarted = 0;
    var mouseInitNode = null;
    var mouseInitTimer = null;
    var MAX_MOUSE_QUEUE = 8;
    var mouseBusy = false;
    var mouseQueue = [];

    function findMouseNode() {
        if (cachedMouseNode && (Date.now() - cachedMouseNodeAt < MOUSE_NODE_CACHE_MS)) {
            return cachedMouseNode;
        }
        try {
            var txt = fs.readFileSync(inputDevicesPath, 'utf8');
            var blocks = txt.split(/\n\s*\n/);
            var fallback = null;
            var found = null;
            for (var i = 0; i < blocks.length; i++) {
                var b = blocks[i];
                var hm = /^H:\s*Handlers=(.*)$/m.exec(b);
                if (!hm || !/\bmouse\d+\b/.test(hm[1])) continue;
                var em = /\bevent(\d{1,2})\b/.exec(hm[1]);
                if (!em) continue;
                var node = '/dev/input/event' + em[1];
                if (/Remote-Input\(Mouse\)|SMART_VIEW/i.test(b)) {
                    found = node;
                    break;
                }
                if (!fallback) fallback = node;
            }
            if (!found) found = fallback;
            if (found) {
                cachedMouseNode = found;
                cachedMouseNodeAt = Date.now();
            }
            return found;
        } catch (e) {
            return null;
        }
    }

    function dbusWm(method, args, reply) {
        return 'dbus-send --system ' + (reply ? '--print-reply' : '--type=method_call') +
            ' --dest=org.enlightenment.wm /org/enlightenment/wm org.enlightenment.wm.info.' +
            method + (args ? (' ' + args) : '');
    }

    function dbusMouse(btn, dx, dy, state, reply) {
        return dbusWm('mousegen', 'int32:' + btn + ' int32:' + dx + ' int32:' + dy + ' int32:' + state, reply);
    }

    function runShell(cmds) {
        if (cmds.length === 1) return cmds[0];
        return "sh -c '" + cmds.slice(0, -1).join(' >/dev/null 2>&1; ') + ' >/dev/null 2>&1; ' + cmds[cmds.length - 1] + "'";
    }

    function buildJumpCmds(x, y) {
        var cmds = [dbusMouse(0, -2000, -2000, 2), dbusMouse(0, -2000, -2000, 2)];
        if (x < 36 && y < 36 && (x > 0 || y > 0)) {
            cmds.push(dbusMouse(0, 100, 100, 2), dbusMouse(0, Math.round((x - 200) / 2), Math.round((y - 200) / 2), 2));
        } else if (x > 0 || y > 0) {
            cmds.push(dbusMouse(0, Math.round(x / 2), Math.round(y / 2), 2));
        }
        return cmds;
    }

    function clearMouseHoldTimer() {
        if (mouseHoldTimer) {
            clearTimeout(mouseHoldTimer);
            mouseHoldTimer = null;
        }
    }

    function startMouseHoldTimer(node, isRefresh) {
        clearMouseHoldTimer();
        var now = Date.now();
        if (!isRefresh || !mouseHoldStarted) {
            mouseHoldStarted = now;
        }
        var remaining = 30000 - (now - mouseHoldStarted);
        if (remaining <= 0) {
            stopMouseHold(false);
            return;
        }
        mouseHeldNode = node;
        mouseHoldTimer = setTimeout(function () {
            mouseHoldTimer = null;
            try {
                stopMouseHold(false);
            } catch (e) {}
        }, Math.min(6000, remaining));
    }

    function stopMouseHold(alsoDeinit) {
        clearMouseHoldTimer();
        mouseHoldStarted = 0;
        if (alsoDeinit && mouseInitTimer) {
            clearTimeout(mouseInitTimer);
            mouseInitTimer = null;
        }
        var cmds = [];
        if (mouseHeldNode) {
            cmds.push(dbusWm('init_device', 'uint32:0 string:' + mouseHeldNode, true), dbusMouse(0, -1, -1, 0));
            mouseHeldNode = null;
        }
        if (alsoDeinit && (mouseInitNode || cmds.length > 0)) {
            mouseInitNode = null;
            cmds.push(dbusWm('deinit_device'));
        }
        if (cmds.length > 0) {
            try {
                ctx.execute(runShell(cmds), 2000).catch(function () {});
            } catch (e) {}
        }
    }

    function touchMouseInit(node) {
        mouseInitNode = node;
        if (mouseInitTimer) clearTimeout(mouseInitTimer);
        mouseInitTimer = setTimeout(function () {
            mouseInitTimer = null;
            if (mouseInitNode && !mouseHeldNode) {
                mouseInitNode = null;
                try {
                    ctx.execute(dbusWm('deinit_device'), 2000).catch(function () {});
                } catch (e) {}
            }
        }, 8000);
    }

    function clearMouseQueue() {
        mouseBusy = false;
        var queued = mouseQueue;
        mouseQueue = [];
        for (var i = 0; i < queued.length; i++) {
            var q = queued[i];
            if (q && q.res && !q.res.finished) {
                try {
                    q.res.writeHead(503, { 'content-type': 'application/json' });
                    q.res.end(JSON.stringify({ ok: false, error: 'Shard stopped' }));
                } catch (e) {}
            }
        }
    }

    function drainMouseQueue() {
        if (mouseBusy || mouseQueue.length === 0) return;
        var reqItem = mouseQueue.shift();
        mouseBusy = true;

        var node = reqItem.node;
        var action = reqItem.action;
        var actionCmds = [];
        if (action === 'move' && reqItem.hasXY) {
            actionCmds = buildJumpCmds(reqItem.x, reqItem.y);
            actionCmds[actionCmds.length - 1] = actionCmds[actionCmds.length - 1].replace('--type=method_call', '--print-reply');
        } else if (action === 'click' && reqItem.hasXY) {
            actionCmds = buildJumpCmds(reqItem.x, reqItem.y);
            actionCmds.push(dbusMouse(0, -1, -1, 3, true));
        } else if (action === 'clickInPlace') {
            actionCmds = [dbusMouse(0, -1, -1, 3, true)];
        } else if (action === 'dblclick' && reqItem.hasXY) {
            actionCmds = buildJumpCmds(reqItem.x, reqItem.y);
            actionCmds.push(dbusMouse(0, -1, -1, 3), 'usleep 60000', dbusMouse(0, -1, -1, 3, true));
        } else if (action === 'rightclick' && reqItem.hasXY) {
            actionCmds = buildJumpCmds(reqItem.x, reqItem.y);
            actionCmds.push(dbusMouse(1, -1, -1, 3, true));
        } else if (action === 'down' && reqItem.hasXY) {
            actionCmds = buildJumpCmds(reqItem.x, reqItem.y);
            actionCmds.push(dbusMouse(0, -1, -1, 1, true));
            startMouseHoldTimer(node, false);
        } else if (action === 'drag') {
            if (reqItem.dx === 0 && reqItem.dy === 0) {
                if (reqItem.res && !reqItem.res.finished) {
                    try {
                        reqItem.res.writeHead(200, { 'content-type': 'application/json' });
                        reqItem.res.end(JSON.stringify({ ok: true }));
                    } catch (e) {}
                }
                mouseBusy = false;
                drainMouseQueue();
                return;
            }
            if (mouseHeldNode) {
                startMouseHoldTimer(mouseHeldNode, true);
            }
            actionCmds = [dbusMouse(0, reqItem.dx, reqItem.dy, 2, true)];
        } else if (action === 'up') {
            actionCmds = [dbusMouse(0, -1, -1, 0, true)];
            clearMouseHoldTimer();
            mouseHeldNode = null;
            mouseHoldStarted = 0;
        } else if (action === 'wheel') {
            if (reqItem.hasXY) actionCmds = buildJumpCmds(reqItem.x, reqItem.y);
            actionCmds.push(dbusMouse(3, reqItem.w, -1, 2, true));
        }

        var initCmd = dbusWm('init_device', 'uint32:0 string:' + node, true);
        var needInit = (mouseInitNode !== node);
        var runList = needInit ? [initCmd].concat(actionCmds) : actionCmds;
        touchMouseInit(node);

        function finishItem(ok, stderr, errMsg) {
            if (reqItem.res && !reqItem.res.finished) {
                try {
                    reqItem.res.writeHead(200, { 'content-type': 'application/json' });
                    reqItem.res.end(errMsg !== undefined
                        ? JSON.stringify({ ok: false, error: errMsg })
                        : JSON.stringify({ ok: !!ok, stderr: stderr }));
                } catch (e) {}
            }
            mouseBusy = false;
            drainMouseQueue();
        }

        function onOk(r) {
            if (!r || r.exit_code !== 0) {
                mouseInitNode = null;
                invalidateMouseNodeCache();
            }
            finishItem(r && r.exit_code === 0, r && r.stderr);
        }

        function onErr(e) {
            mouseInitNode = null;
            invalidateMouseNodeCache();
            finishItem(false, undefined, e ? e.message : 'mouse command failed');
        }

        try {
            ctx.execute(runShell(runList), 5000).then(function (r) {
                if (!needInit && r && typeof r.stdout === 'string' && r.stdout.indexOf('Initialize device first') !== -1) {
                    touchMouseInit(node);
                    ctx.execute(runShell([initCmd].concat(actionCmds)), 5000).then(onOk, onErr);
                    return;
                }
                onOk(r);
            }, onErr);
        } catch (e) {
            onErr(e);
        }
    }

    function stopHold() {
        if (activeHoldTimer) {
            clearTimeout(activeHoldTimer);
            activeHoldTimer = null;
        }
        if (activeHoldKey) {
            var k = activeHoldKey;
            var pendingDown = activeHoldDownPromise;
            activeHoldKey = null;
            activeHoldDownPromise = null;
            var sendUp = function () {
                try {
                    ctx.execute('/usr/bin/input_keyevent ' + k + ' up', 2000).catch(function () {});
                } catch (e) {}
            };
            if (pendingDown && typeof pendingDown.then === 'function') {
                pendingDown.then(sendUp, sendUp);
            } else {
                sendUp();
            }
        }
    }

    function startHold(key) {
        stopHold();
        activeHoldKey = key;
        var downPromise = null;
        try {
            downPromise = ctx.execute('/usr/bin/input_keyevent ' + key + ' down', 2000).catch(function () {});
        } catch (e) {}
        activeHoldDownPromise = downPromise;
        if (downPromise && typeof downPromise.then === 'function') {
            downPromise.then(function () {
                if (activeHoldDownPromise === downPromise) {
                    activeHoldDownPromise = null;
                }
            }, function () {
                if (activeHoldDownPromise === downPromise) {
                    activeHoldDownPromise = null;
                }
            });
        }
        activeHoldTimer = setTimeout(function () {
            activeHoldTimer = null;
            stopHold();
        }, 6000);
    }

    function getCfg() {
        var c = ctx.config.get();
        return (c && typeof c === 'object') ? c : {};
    }

    function saveCfg(c) {
        ctx.config.set(c);
    }

    function unlinkFile(filePath) {
        fs.unlink(filePath, function (err) {
            if (err && err.code !== 'ENOENT') {
                try {
                    ctx.execute("rm -f '" + filePath + "'", 2000).catch(function () {});
                } catch (e) {}
            }
        });
    }

    var MAX_STREAM_CLIENTS = 4;
    var STREAM_PID_FILE = '/tmp/vetro-keyboard-stream.pid';
    var STOP_STREAM_CMD = "if [ -f " + STREAM_PID_FILE + " ]; then " +
        "pid=$(cat " + STREAM_PID_FILE + " 2>/dev/null); " +
        "case \"$pid\" in ''|*[!0-9]*) ;; *) " +
        "if tr '\\0' ' ' < /proc/\"$pid\"/cmdline 2>/dev/null | grep -q 'tcpclientsink.*127\\.0\\.0\\.1'; then " +
        "kill \"$pid\" 2>/dev/null; sleep 0.15; kill -9 \"$pid\" 2>/dev/null; " +
        "fi ;; esac; " +
        "rm -f " + STREAM_PID_FILE + "; fi";

    var streamClients = [];
    var streamProcRunning = false;
    var streamServer = null;
    var streamPort = 0;
    var streamTcpSocket = null;
    var lastFrame = null;
    var lastFrameTime = 0;
    var streamKillTimer = null;
    var streamNoConnectTimer = null;
    var streamRestartTimer = null;
    var streamPipelineRestarts = 0;
    var streamGeneration = 0;
    var streamPreset = 'balanced';
    var streamWidth = STREAM_PRESETS.balanced.width;
    var streamHeight = STREAM_PRESETS.balanced.height;
    var streamQuality = STREAM_PRESETS.balanced.quality;
    var screenshotWaiters = null;

    function isFiniteQuality(v) {
        return (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && isFinite(Number(v));
    }

    function getStreamConfig() {
        return {
            preset: streamPreset,
            width: streamWidth,
            height: streamHeight,
            quality: streamQuality
        };
    }

    function loadStreamConfig() {
        streamPreset = 'balanced';
        streamWidth = STREAM_PRESETS.balanced.width;
        streamHeight = STREAM_PRESETS.balanced.height;
        streamQuality = STREAM_PRESETS.balanced.quality;
        try {
            var cfg = getCfg();
            if (typeof cfg.streamPreset === 'string' &&
                Object.prototype.hasOwnProperty.call(STREAM_PRESETS, cfg.streamPreset)) {
                streamPreset = cfg.streamPreset;
                streamWidth = STREAM_PRESETS[streamPreset].width;
                streamHeight = STREAM_PRESETS[streamPreset].height;
                streamQuality = STREAM_PRESETS[streamPreset].quality;
            }
            if (isFiniteQuality(cfg.streamQuality)) {
                streamQuality = Math.max(20, Math.min(95, Math.round(Number(cfg.streamQuality))));
            }
        } catch (e) {}
    }

    function scheduleStreamRestart() {
        if (streamRestartTimer) {
            clearTimeout(streamRestartTimer);
            streamRestartTimer = null;
        }
        if (!streamProcRunning || streamClients.length === 0) return;
        streamRestartTimer = setTimeout(function () {
            streamRestartTimer = null;
            try {
                if (streamClients.length === 0) return;
                if (streamNoConnectTimer) {
                    clearTimeout(streamNoConnectTimer);
                    streamNoConnectTimer = null;
                }
                if (streamTcpSocket) {
                    var oldSock = streamTcpSocket;
                    streamTcpSocket = null;
                    try { oldSock.destroy(); } catch (e) {}
                }
                if (streamServer && streamPort === 0) {
                    var oldSrv = streamServer;
                    streamServer = null;
                    try { oldSrv.close(); } catch (e) {}
                }
                streamPipelineRestarts = 0;
                lastFrame = null;
                lastFrameTime = 0;
                streamProcRunning = false;
                startStreamPipeline();
            } catch (e) {}
        }, 200);
    }

    function applyStreamConfig(opts, persist) {
        if (opts && typeof opts === 'object') {
            var prevPreset = streamPreset;
            var prevWidth = streamWidth;
            var prevHeight = streamHeight;
            var prevQuality = streamQuality;
            var key = opts.preset || opts.mode;
            var hasExplicitQuality = isFiniteQuality(opts.quality);
            if (typeof key === 'string' && Object.prototype.hasOwnProperty.call(STREAM_PRESETS, key)) {
                streamPreset = key;
                streamWidth = STREAM_PRESETS[key].width;
                streamHeight = STREAM_PRESETS[key].height;
                if (!hasExplicitQuality) {
                    streamQuality = STREAM_PRESETS[key].quality;
                }
            }
            if (hasExplicitQuality) {
                streamQuality = Math.max(20, Math.min(95, Math.round(Number(opts.quality))));
            }
            var changed = (streamPreset !== prevPreset || streamWidth !== prevWidth ||
                streamHeight !== prevHeight || streamQuality !== prevQuality);
            if (changed) {
                if (persist) {
                    try {
                        var c = getCfg();
                        c.streamPreset = streamPreset;
                        c.streamQuality = streamQuality;
                        saveCfg(c);
                    } catch (e) {}
                }
                if (streamProcRunning && streamClients.length > 0) {
                    scheduleStreamRestart();
                }
            }
        }
        return getStreamConfig();
    }

    function allocBuf(n) {
        return (typeof Buffer.alloc === 'function') ? Buffer.alloc(n) : new Buffer(n);
    }

    function asciiBuf(str) {
        return (typeof Buffer.from === 'function') ? Buffer.from(str, 'ascii') : new Buffer(str, 'ascii');
    }

    function createJpegParser(onFrame) {
        var buffer = allocBuf(0);
        return function (chunk) {
            try {
                if (!chunk || chunk.length === 0) return;
                buffer = Buffer.concat([buffer, chunk]);
                if (buffer.length > 2097152) {
                    // Guard against unbounded growth if EOI marker is missed
                    buffer = buffer.slice(buffer.length - 65536);
                }
                var latestFrame = null;
                while (buffer.length > 4) {
                    var start = -1;
                    for (var i = 0; i < buffer.length - 1; i++) {
                        if (buffer[i] === 0xFF && buffer[i + 1] === 0xD8) {
                            start = i;
                            break;
                        }
                    }
                    if (start === -1) {
                        buffer = buffer.slice(Math.max(0, buffer.length - 1));
                        break;
                    }
                    var end = -1;
                    for (var j = start + 2; j < buffer.length - 1; j++) {
                        if (buffer[j] === 0xFF && buffer[j + 1] === 0xD9) {
                            end = j + 2;
                            break;
                        }
                    }
                    if (end === -1) {
                        if (start > 0) buffer = buffer.slice(start);
                        break;
                    }
                    latestFrame = buffer.slice(start, end);
                    buffer = buffer.slice(end);
                }
                if (latestFrame) {
                    onFrame(latestFrame);
                }
            } catch (e) {}
        };
    }

    function isClientReady(c) {
        if (!c || c.closed || !c.res || !c.res.socket || !c.res.socket.writable || c.res.finished) return false;
        if (c.busy && (Date.now() - c.lastSendTime > 2500)) {
            c.busy = false;
        }
        return !c.busy && ((c.res.socket.bufferSize || 0) === 0);
    }

    function checkAllClientsClosed() {
        if (streamClients.length === 0 && !streamKillTimer) {
            streamKillTimer = setTimeout(function () {
                streamKillTimer = null;
                try {
                    if (streamClients.length === 0) {
                        stopStreamPipeline();
                    }
                } catch (e) {}
            }, 2000);
        }
    }

    function removeStreamClient(c) {
        if (!c || c.closed) return;
        c.closed = true;
        var idx = streamClients.indexOf(c);
        if (idx !== -1) streamClients.splice(idx, 1);
        checkAllClientsClosed();
    }

    function closeAllStreamClients() {
        for (var i = streamClients.length - 1; i >= 0; i--) {
            streamClients[i].closed = true;
            try { streamClients[i].res.end(); } catch (e) {}
        }
        streamClients = [];
    }

    function writeMjpegClient(c, payload) {
        if (!c || c.closed) return;
        c.busy = true;
        c.lastSendTime = Date.now();
        try {
            c.res.write(payload, function () {
                c.busy = false;
                c.lastWriteOk = Date.now();
            });
        } catch (e) {
            c.busy = false;
            removeStreamClient(c);
        }
    }

    function broadcastFrame(frame) {
        if (!frame || frame.length === 0) return;
        var now = Date.now();
        lastFrame = frame;
        lastFrameTime = now;
        if (streamClients.length === 0) return;
        var partHdr = asciiBuf('--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ' + frame.length + '\r\n\r\n');
        var payload = Buffer.concat([partHdr, frame, asciiBuf('\r\n')]);
        for (var i = streamClients.length - 1; i >= 0; i--) {
            var c = streamClients[i];
            if (!c || c.closed || !c.res || !c.res.socket || !c.res.socket.writable || c.res.finished) {
                removeStreamClient(c);
                continue;
            }
            if (isClientReady(c)) {
                writeMjpegClient(c, payload);
            } else if ((now - c.lastWriteOk) > 15000) {
                try { c.res.end(); } catch (e) {}
                try { c.res.socket.destroy(); } catch (e) {}
                removeStreamClient(c);
            }
        }
    }

    function onStreamSocket(sock) {
        try {
            var remote = sock.remoteAddress ? String(sock.remoteAddress).replace(/^::ffff:/i, '') : '';
            if (remote && remote !== '127.0.0.1') {
                try { sock.destroy(); } catch (e) {}
                return;
            }
            if (!streamProcRunning || streamClients.length === 0) {
                try { sock.destroy(); } catch (e) {}
                return;
            }
            if (streamTcpSocket) {
                var prev = streamTcpSocket;
                streamTcpSocket = null;
                try { prev.destroy(); } catch (e) {}
            }
            streamTcpSocket = sock;
            if (streamNoConnectTimer) {
                clearTimeout(streamNoConnectTimer);
                streamNoConnectTimer = null;
            }
            streamPipelineRestarts = 0;
            if (sock.setNoDelay) sock.setNoDelay(true);
            sock.on('data', createJpegParser(broadcastFrame));

            var handleDisconnect = function () {
                try {
                    if (streamTcpSocket !== sock) {
                        try { sock.destroy(); } catch (e) {}
                        return;
                    }
                    streamTcpSocket = null;
                    try { sock.destroy(); } catch (e) {}
                    if (streamClients.length > 0 && streamProcRunning && !streamRestartTimer) {
                        if (streamPipelineRestarts < 1) {
                            streamPipelineRestarts++;
                            streamProcRunning = false;
                            startStreamPipeline();
                        } else {
                            stopStreamPipeline();
                            closeAllStreamClients();
                        }
                    }
                } catch (e) {}
            };

            sock.on('error', handleDisconnect);
            sock.on('close', handleDisconnect);
        } catch (e) {
            try { sock.destroy(); } catch (e2) {}
        }
    }

    function launchGst(gen, port) {
        if (!streamProcRunning || gen !== streamGeneration) return;
        var gstCmd = STOP_STREAM_CMD + "; " +
            "command -v gst-launch-1.0 >/dev/null 2>&1 || exit 127; " +
            "WAYLAND_DISPLAY=wayland-0 XDG_RUNTIME_DIR=/run gst-launch-1.0 -q waylandsrc ! " +
            "video/x-raw,width=1920,height=1080 ! " +
            "videoscale method=0 n-threads=2 ! video/x-raw,width=" + streamWidth + ",height=" + streamHeight + " ! " +
            "videoconvert n-threads=2 ! " +
            "jpegenc quality=" + streamQuality + " idct-method=1 ! " +
            "tcpclientsink host=127.0.0.1 port=" + port + " sync=false </dev/null >/dev/null 2>&1 & " +
            "echo $! > " + STREAM_PID_FILE;
        if (streamNoConnectTimer) clearTimeout(streamNoConnectTimer);
        streamNoConnectTimer = setTimeout(function () {
            streamNoConnectTimer = null;
            try {
                if (!streamTcpSocket && streamProcRunning && gen === streamGeneration) {
                    stopStreamPipeline();
                    closeAllStreamClients();
                }
            } catch (e) {}
        }, 3500);
        var onResolve = function (r) {
            try {
                if (!streamProcRunning) {
                    ctx.execute(STOP_STREAM_CMD, 2000).catch(function () {});
                    return;
                }
                if (gen !== streamGeneration) return;
                if (r && r.exit_code !== 0) {
                    stopStreamPipeline();
                    closeAllStreamClients();
                }
            } catch (e) {}
        };
        var onReject = function () {
            try {
                if (!streamProcRunning) {
                    ctx.execute(STOP_STREAM_CMD, 2000).catch(function () {});
                    return;
                }
                if (gen !== streamGeneration) return;
                stopStreamPipeline();
                closeAllStreamClients();
            } catch (e) {}
        };
        try {
            ctx.execute(gstCmd, 5000).then(onResolve, onReject);
        } catch (e) {
            stopStreamPipeline();
            closeAllStreamClients();
        }
    }

    function startStreamPipeline() {
        if (streamProcRunning) return;
        streamProcRunning = true;
        var gen = ++streamGeneration;
        if (streamServer && streamPort > 0) {
            launchGst(gen, streamPort);
            return;
        }
        var srv;
        try {
            srv = net.createServer(onStreamSocket);
        } catch (e) {
            stopStreamPipeline();
            closeAllStreamClients();
            return;
        }
        streamServer = srv;
        srv.on('error', function () {
            try {
                if (streamServer === srv) {
                    stopStreamPipeline();
                    closeAllStreamClients();
                }
            } catch (e) {}
        });
        try {
            srv.listen(0, '127.0.0.1', function () {
                try {
                    if (!streamProcRunning || gen !== streamGeneration || streamServer !== srv || streamClients.length === 0) {
                        if (streamServer === srv) {
                            streamServer = null;
                            streamPort = 0;
                            if (gen === streamGeneration) {
                                streamProcRunning = false;
                                if (streamKillTimer) {
                                    clearTimeout(streamKillTimer);
                                    streamKillTimer = null;
                                }
                            }
                        }
                        try { srv.close(); } catch (e) {}
                        return;
                    }
                    var addr = srv.address();
                    if (!addr || !addr.port) {
                        stopStreamPipeline();
                        closeAllStreamClients();
                        return;
                    }
                    streamPort = addr.port;
                    launchGst(gen, streamPort);
                } catch (e) {
                    stopStreamPipeline();
                    closeAllStreamClients();
                }
            });
        } catch (e) {
            stopStreamPipeline();
            closeAllStreamClients();
        }
    }

    function stopStreamPipeline() {
        var wasRunning = streamProcRunning;
        streamProcRunning = false;
        streamGeneration++;
        streamPipelineRestarts = 0;
        lastFrame = null;
        lastFrameTime = 0;
        if (streamRestartTimer) {
            clearTimeout(streamRestartTimer);
            streamRestartTimer = null;
        }
        if (streamKillTimer) {
            clearTimeout(streamKillTimer);
            streamKillTimer = null;
        }
        if (streamNoConnectTimer) {
            clearTimeout(streamNoConnectTimer);
            streamNoConnectTimer = null;
        }
        if (streamTcpSocket) {
            var s = streamTcpSocket;
            streamTcpSocket = null;
            try { s.destroy(); } catch (e) {}
        }
        if (streamServer) {
            var srv = streamServer;
            streamServer = null;
            streamPort = 0;
            try { srv.close(); } catch (e) {}
        }
        if (wasRunning) {
            try {
                ctx.execute(STOP_STREAM_CMD, 2000).catch(function () {});
            } catch (e) {}
        }
    }

    function takeShotWaiters() {
        var list = screenshotWaiters;
        screenshotWaiters = null;
        return list || [];
    }

    function finishShotOk(contentType, data) {
        var list = takeShotWaiters();
        for (var i = 0; i < list.length; i++) {
            var r = list[i];
            if (!r || r.finished) continue;
            try {
                r.writeHead(200, {
                    'content-type': contentType,
                    'cache-control': 'no-store, must-revalidate',
                    'content-length': data.length
                });
                r.end(data);
            } catch (e) {}
        }
    }

    function finishShotErr(msg) {
        var list = takeShotWaiters();
        var body = JSON.stringify({ ok: false, error: msg || 'Screenshot capture failed' });
        for (var i = 0; i < list.length; i++) {
            var r = list[i];
            if (!r || r.finished) continue;
            try {
                r.writeHead(500, { 'content-type': 'application/json' });
                r.end(body);
            } catch (e) {}
        }
    }

    function clearScreenshotWaiters() {
        if (screenshotWaiters) {
            finishShotErr('Shard stopped');
        }
    }

    function readAndServeShot(filePath, contentType) {
        fs.readFile(filePath, function (err, data) {
            unlinkFile(filePath);
            if (err) {
                finishShotErr(err.message);
                return;
            }
            finishShotOk(contentType, data);
        });
    }

    function runScreenshotCapture() {
        var shotId = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
        var shotPath = '/tmp/shot_' + shotId + '.jpg';
        var shotFallbackPath = '/tmp/shot_' + shotId + '.png';
        var gstCmd = "WAYLAND_DISPLAY=wayland-0 XDG_RUNTIME_DIR=/run gst-launch-1.0 -q waylandsrc num-buffers=1 ! video/x-raw,width=1920,height=1080 ! videoconvert ! jpegenc quality=85 ! filesink location='" + shotPath + "'";
        var dbusCmd = "dbus-send --system --print-reply --dest=org.enlightenment.wm /org/enlightenment/wm org.enlightenment.wm.info.dump_screen string:'" + shotFallbackPath + "'";

        function fallbackDbus() {
            if (!screenshotWaiters) return;
            ctx.execute(dbusCmd, 10000).then(function (r) {
                if (!r || r.exit_code !== 0) {
                    unlinkFile(shotFallbackPath);
                    finishShotErr((r && r.stderr) || 'Screenshot capture failed');
                    return;
                }
                readAndServeShot(shotFallbackPath, 'image/png');
            }, function (e) {
                unlinkFile(shotFallbackPath);
                finishShotErr(e ? e.message : 'Screenshot capture failed');
            });
        }

        ctx.execute(gstCmd, 5000).then(function (r) {
            if (r && r.exit_code === 0) {
                fs.stat(shotPath, function (err, stat) {
                    if (!err && stat && stat.size > 1000) {
                        readAndServeShot(shotPath, 'image/jpeg');
                        return;
                    }
                    unlinkFile(shotPath);
                    fallbackDbus();
                });
            } else {
                unlinkFile(shotPath);
                fallbackDbus();
            }
        }, function () {
            unlinkFile(shotPath);
            fallbackDbus();
        });
    }

    function getClientIp(req) {
        var ip = '';
        if (req && req.socket && req.socket.remoteAddress) {
            ip = String(req.socket.remoteAddress);
        } else if (req && req.connection && req.connection.remoteAddress) {
            ip = String(req.connection.remoteAddress);
        }
        return ip.replace(/^::ffff:/i, '');
    }

    function lookupArpMac(ip) {
        if (!ip || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return null;
        try {
            var arp = fs.readFileSync(arpPath, 'utf8');
            var lines = arp.split('\n');
            for (var i = 1; i < lines.length; i++) {
                var cols = lines[i].replace(/^\s+|\s+$/g, '').split(/\s+/);
                if (cols.length >= 4 && cols[0] === ip && cols[2] !== '0x0') {
                    var mac = cols[3].toLowerCase();
                    if (/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac) && mac !== '00:00:00:00:00:00') {
                        return mac;
                    }
                }
            }
        } catch (e) {}
        return null;
    }

    function ensureTokenSalt(cfg) {
        if (cfg && typeof cfg.salt === 'string' && /^[0-9a-f]{32,64}$/.test(cfg.salt)) {
            return cfg.salt;
        }
        var salt = crypto.randomBytes(16).toString('hex');
        if (cfg && typeof cfg === 'object') {
            cfg.salt = salt;
            try { saveCfg(cfg); } catch (e) {}
        }
        return salt;
    }

    function getClientIdentity(req, cfg, createSalt) {
        var salt = (cfg && typeof cfg.salt === 'string' && /^[0-9a-f]{32,64}$/.test(cfg.salt))
            ? cfg.salt
            : (createSalt ? ensureTokenSalt(cfg) : null);
        if (!salt) return null;
        var ip = getClientIp(req);
        var mac = lookupArpMac(ip);
        var raw = mac ? ('mac:' + mac) : (ip ? ('ip:' + ip) : 'local');
        var key = crypto.createHmac('sha256', salt).update(raw).digest('hex').slice(0, 16);
        return { key: key, tag: key.slice(0, 4) };
    }

    function hasAnySavedToken(cfg) {
        if (!cfg || typeof cfg !== 'object') return false;
        if (typeof cfg.token === 'string' && cfg.token.length > 0) return true;
        if (cfg.tokens && typeof cfg.tokens === 'object' && !Array.isArray(cfg.tokens)) {
            var keys = Object.keys(cfg.tokens);
            for (var i = 0; i < keys.length; i++) {
                var v = cfg.tokens[keys[i]];
                if (typeof v === 'string' && v.length > 0) return true;
            }
        }
        return false;
    }

    function getTokenForClient(cfg, req, createSalt) {
        var id = getClientIdentity(req, cfg, createSalt);
        var tokens = (cfg && cfg.tokens && typeof cfg.tokens === 'object' && !Array.isArray(cfg.tokens)) ? cfg.tokens : null;
        if (id && tokens && typeof tokens[id.key] === 'string' && tokens[id.key].length > 0) {
            return { token: tokens[id.key], deviceTag: id.tag, legacy: false };
        }
        if (cfg && typeof cfg.token === 'string' && cfg.token.length > 0 && (!tokens || Object.keys(tokens).length === 0)) {
            return { token: cfg.token, deviceTag: id ? id.tag : null, legacy: true };
        }
        return { token: null, deviceTag: id ? id.tag : null, legacy: false };
    }

    return {
        start: function () {
            loadStreamConfig();
            page = loadPage(ctx);
        },

        stop: function () {
            stopHold();
            clearMouseQueue();
            stopMouseHold(true);
            invalidateMouseNodeCache();
            closeAllStreamClients();
            stopStreamPipeline();
            clearScreenshotWaiters();
            page = null;
        },

        status: function () {
            return { paired: hasAnySavedToken(getCfg()) };
        },

        route: function (req, res, sub) {

            // GET api/ui
            if (sub === 'ui' && req.method === 'GET') {
                if (!page) page = loadPage(ctx);
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
                res.end(page || '');
                return true;
            }

            // GET api/status
            if (sub === 'status' && req.method === 'GET') {
                var cfg0 = getCfg();
                var tok0 = getTokenForClient(cfg0, req, false);
                res.writeHead(200, {
                    'content-type': 'application/json',
                    'cache-control': 'no-store'
                });
                res.end(JSON.stringify({
                    ok: true,
                    paired: !!tok0.token,
                    tvIp: getTvIp(),
                    stream: getStreamConfig()
                }));
                return true;
            }

            // GET api/token — returns caller device's own Samsung Remote pairing token and anonymous tag
            if (sub === 'token' && req.method === 'GET') {
                var cfgTok = getCfg();
                var tokInfo = getTokenForClient(cfgTok, req, true);
                res.writeHead(200, {
                    'content-type': 'application/json',
                    'cache-control': 'no-store'
                });
                res.end(JSON.stringify({
                    ok: true,
                    token: tokInfo.token,
                    deviceTag: tokInfo.deviceTag,
                    legacy: tokInfo.legacy || undefined
                }));
                return true;
            }

            // POST api/savetoken
            if (sub === 'savetoken' && req.method === 'POST') {
                readJson(req, 4096, function (err, parsed) {
                    if (err) {
                        res.writeHead(400, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: err.message }));
                        return;
                    }
                    try {
                        var isSave = (typeof parsed.token === 'string' && parsed.token.length > 0 && parsed.token.length < 256);
                        var isReset = (!isSave && !!(parsed.reset || parsed.token === null));
                        if (isSave || isReset) {
                            var c2 = getCfg();
                            var devId = getClientIdentity(req, c2, isSave);
                            var srcMap = (c2.tokens && typeof c2.tokens === 'object' && !Array.isArray(c2.tokens)) ? c2.tokens : {};
                            var map = {};
                            var existingKeys = Object.keys(srcMap);
                            for (var kIdx = 0; kIdx < existingKeys.length; kIdx++) {
                                var kName = existingKeys[kIdx];
                                if (typeof srcMap[kName] === 'string' && srcMap[kName].length > 0) {
                                    map[kName] = srcMap[kName];
                                }
                            }
                            var changed = false;
                            if (isSave && devId && devId.key) {
                                if (map[devId.key] !== parsed.token || c2.token !== undefined || existingKeys[existingKeys.length - 1] !== devId.key) {
                                    delete map[devId.key];
                                    map[devId.key] = parsed.token;
                                    var keys = Object.keys(map);
                                    while (keys.length > MAX_TOKEN_DEVICES) {
                                        delete map[keys.shift()];
                                    }
                                    c2.tokens = map;
                                    delete c2.token;
                                    changed = true;
                                }
                            } else if (isReset) {
                                if (devId && devId.key && Object.prototype.hasOwnProperty.call(map, devId.key)) {
                                    delete map[devId.key];
                                    if (Object.keys(map).length > 0) {
                                        c2.tokens = map;
                                    } else {
                                        delete c2.tokens;
                                    }
                                    changed = true;
                                }
                                if (Object.prototype.hasOwnProperty.call(c2, 'token')) {
                                    delete c2.token;
                                    changed = true;
                                }
                            }
                            if (changed) saveCfg(c2);
                        }
                        res.writeHead(200, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: true }));
                    } catch (e) {
                        res.writeHead(500, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: 'failed to save configuration' }));
                    }
                });
                return true;
            }

            // POST api/key — inject single keysym or manage hold action
            if (sub === 'key' && req.method === 'POST') {
                readJson(req, 4096, function (err, parsed) {
                    if (err) {
                        res.writeHead(400, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: err.message }));
                        return;
                    }
                    var key = parsed.key;
                    var action = parsed.action;
                    var isShift = !!parsed.shift;
                    var isCtrl = !!parsed.ctrl;

                    if (!key || typeof key !== 'string' || !/^[A-Za-z0-9_]+$/.test(key)) {
                        res.writeHead(400, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: 'invalid key name' }));
                        return;
                    }

                    if (action === 'down') {
                        startHold(key);
                        res.writeHead(200, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: true, holding: true }));
                        return;
                    }

                    if (action === 'up') {
                        stopHold();
                        res.writeHead(200, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: true, holding: false }));
                        return;
                    }

                    // Single tap / click
                    stopHold();

                    if (/^[A-Z]$/.test(key)) {
                        key = key.toLowerCase();
                        isShift = true;
                    }

                    var cmd;
                    if (isCtrl) {
                        cmd = 'sh -c "/usr/bin/input_keyevent Control_L down; /usr/bin/input_keyevent ' + key + '; /usr/bin/input_keyevent Control_L up"';
                    } else if (isShift) {
                        cmd = 'sh -c "/usr/bin/input_keyevent Shift_L down; /usr/bin/input_keyevent ' + key + '; /usr/bin/input_keyevent Shift_L up"';
                    } else {
                        cmd = '/usr/bin/input_keyevent ' + key;
                    }

                    ctx.execute(cmd, 5000).then(function (r) {
                        res.writeHead(200, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: r.exit_code === 0, stderr: r.stderr }));
                    }, function (e) {
                        res.writeHead(200, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: e.message }));
                    });
                });
                return true;
            }

            // POST api/type — inject ASCII string via input_keyevent sequence
            if (sub === 'type' && req.method === 'POST') {
                readJson(req, 4096, function (err, parsed) {
                    if (err) {
                        res.writeHead(400, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: err.message }));
                        return;
                    }
                    var text = parsed.text;
                    if (!text || typeof text !== 'string') {
                        res.writeHead(400, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: 'missing text' }));
                        return;
                    }
                    var truncated = false;
                    if (text.length > 200) {
                        text = text.slice(0, 200);
                        truncated = true;
                    }
                    var cmds = [];
                    var dropped = [];
                    for (var i = 0; i < text.length; i++) {
                        var ch = text[i];
                        if (/^[a-z0-9]$/.test(ch)) {
                            cmds.push('/usr/bin/input_keyevent ' + ch);
                        } else if (/^[A-Z]$/.test(ch)) {
                            cmds.push('/usr/bin/input_keyevent Shift_L down; /usr/bin/input_keyevent ' + ch.toLowerCase() + '; /usr/bin/input_keyevent Shift_L up');
                        } else if (SHIFT_MAP[ch]) {
                            cmds.push('/usr/bin/input_keyevent Shift_L down; /usr/bin/input_keyevent ' + SHIFT_MAP[ch] + '; /usr/bin/input_keyevent Shift_L up');
                        } else if (LATIN_MAP[ch]) {
                            cmds.push('/usr/bin/input_keyevent ' + LATIN_MAP[ch]);
                        } else {
                            dropped.push(ch);
                        }
                    }
                    if (cmds.length === 0) {
                        res.writeHead(200, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({
                            ok: true,
                            dropped: dropped.length > 0 ? dropped : undefined,
                            truncated: truncated || undefined
                        }));
                        return;
                    }
                    var cmd = "sh -c '" + cmds.join('; sleep 0.04; ') + "'";
                    ctx.execute(cmd, 15000).then(function (r) {
                        res.writeHead(200, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({
                            ok: r.exit_code === 0,
                            dropped: dropped.length > 0 ? dropped : undefined,
                            truncated: truncated || undefined,
                            stderr: r.stderr
                        }));
                    }, function (e) {
                        res.writeHead(200, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: e.message }));
                    });
                });
                return true;
            }

            // POST api/mouse — fast fallback cursor jump/click/drag and scroll wheel via Enlightenment D-Bus
            if (sub === 'mouse' && req.method === 'POST') {
                readJson(req, 4096, function (err, parsed) {
                    if (err) {
                        res.writeHead(400, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: err.message }));
                        return;
                    }
                    var action = String(parsed.action || 'click');
                    var node = findMouseNode();
                    if (!node) {
                        res.writeHead(200, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: 'no mouse device node' }));
                        return;
                    }
                    var hasXY = (typeof parsed.x === 'number' && typeof parsed.y === 'number' && isFinite(parsed.x) && isFinite(parsed.y));
                    var x = hasXY ? Math.max(0, Math.min(1919, Math.round(parsed.x))) : 0;
                    var y = hasXY ? Math.max(0, Math.min(1079, Math.round(parsed.y))) : 0;
                    var dx = 0;
                    var dy = 0;
                    var w = -1;

                    if ((action === 'move' || action === 'click' || action === 'dblclick' || action === 'rightclick' || action === 'down') && hasXY) {
                        // valid positional action
                    } else if (action === 'clickInPlace' || action === 'up') {
                        // valid non-positional action
                    } else if (action === 'drag') {
                        dx = Math.max(-2000, Math.min(2000, Math.round(Number(parsed.dx) || 0)));
                        dy = Math.max(-2000, Math.min(2000, Math.round(Number(parsed.dy) || 0)));
                        if (dx === 0 && dy === 0) {
                            res.writeHead(200, { 'content-type': 'application/json' });
                            res.end(JSON.stringify({ ok: true }));
                            return;
                        }
                    } else if (action === 'wheel') {
                        w = Math.max(-5, Math.min(5, Math.round(Number(parsed.delta) || 0)));
                        if (w === 0) w = -1;
                    } else {
                        res.writeHead(400, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: 'invalid mouse action' }));
                        return;
                    }

                    var tail = mouseQueue.length > 0 ? mouseQueue[mouseQueue.length - 1] : null;
                    if (action === 'drag' && tail && tail.action === 'drag' && tail.node === node) {
                        tail.dx = Math.max(-2000, Math.min(2000, tail.dx + dx));
                        tail.dy = Math.max(-2000, Math.min(2000, tail.dy + dy));
                        res.writeHead(200, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: true }));
                        return;
                    }
                    if (mouseBusy && mouseQueue.length >= MAX_MOUSE_QUEUE) {
                        res.writeHead(503, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: 'mouse queue full' }));
                        return;
                    }
                    mouseQueue.push({
                        node: node,
                        action: action,
                        hasXY: hasXY,
                        x: x,
                        y: y,
                        dx: dx,
                        dy: dy,
                        w: w,
                        res: res
                    });
                    drainMouseQueue();
                });
                return true;
            }

            // POST api/stream_preset — configure live MJPEG stream preset and JPEG quality
            if (sub === 'stream_preset' && req.method === 'POST') {
                readJson(req, 4096, function (err, parsed) {
                    if (err) {
                        res.writeHead(400, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: err.message }));
                        return;
                    }
                    var rawPreset = parsed.preset || parsed.mode;
                    var hasPreset = (typeof rawPreset === 'string' &&
                        Object.prototype.hasOwnProperty.call(STREAM_PRESETS, rawPreset));
                    var hasQuality = isFiniteQuality(parsed.quality);
                    if (!hasPreset && !hasQuality) {
                        res.writeHead(400, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: 'invalid preset or quality' }));
                        return;
                    }
                    var cfgOut = applyStreamConfig({
                        preset: hasPreset ? rawPreset : undefined,
                        quality: hasQuality ? Number(parsed.quality) : undefined
                    }, true);
                    res.writeHead(200, {
                        'content-type': 'application/json',
                        'cache-control': 'no-store'
                    });
                    res.end(JSON.stringify({
                        ok: true,
                        preset: cfgOut.preset,
                        width: cfgOut.width,
                        height: cfgOut.height,
                        quality: cfgOut.quality
                    }));
                });
                return true;
            }

            // GET api/stream — persistent low-latency MJPEG live stream with zero-backlog drop policy
            if (sub === 'stream' && req.method === 'GET') {
                if (streamClients.length >= MAX_STREAM_CLIENTS) {
                    res.writeHead(503, {
                        'content-type': 'application/json',
                        'cache-control': 'no-store'
                    });
                    res.end(JSON.stringify({ ok: false, error: 'too many stream viewers' }));
                    return true;
                }
                res.writeHead(200, {
                    'content-type': 'multipart/x-mixed-replace; boundary=--frame',
                    'cache-control': 'no-cache, no-store, must-revalidate',
                    'pragma': 'no-cache',
                    'connection': 'close'
                });
                if (res.socket && res.socket.setNoDelay) res.socket.setNoDelay(true);
                var client = {
                    res: res,
                    busy: false,
                    lastSendTime: 0,
                    lastWriteOk: Date.now(),
                    closed: false
                };
                streamClients.push(client);
                if (streamKillTimer) {
                    clearTimeout(streamKillTimer);
                    streamKillTimer = null;
                }
                startStreamPipeline();
                if (lastFrame && (Date.now() - lastFrameTime < 1500)) {
                    var initHdr = asciiBuf('--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ' + lastFrame.length + '\r\n\r\n');
                    writeMjpegClient(client, Buffer.concat([initHdr, lastFrame, asciiBuf('\r\n')]));
                }
                var onDisconnect = function () {
                    try {
                        removeStreamClient(client);
                    } catch (e) {}
                };
                req.on('close', onDisconnect);
                req.on('error', onDisconnect);
                res.on('close', onDisconnect);
                res.on('error', onDisconnect);
                return true;
            }

            // GET api/screenshot — captures crisp 1080p JPEG via Wayland (or Enlightenment WM PNG fallback)
            if (sub === 'screenshot' && req.method === 'GET') {
                if (screenshotWaiters) {
                    screenshotWaiters.push(res);
                    return true;
                }
                screenshotWaiters = [res];
                runScreenshotCapture();
                return true;
            }

            return false;
        }
    };
};
