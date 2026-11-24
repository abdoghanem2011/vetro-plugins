'use strict';

// Vetro Shard: TV Channels
//
// Fast satellite & IP channel browser, frequency search, and instant channel switcher.
// Reads directly from Tizen's channel management database:
//   - DVB-S Satellite: /mnt/systemrw/tvs-chms/data/dvbs & sat
//   - IPTV (Samsung TV Plus): /mnt/systemrw/tvs-chms/data/ipsrv
// Tunes channels instantly via /usr/bin/launch_app org.tizen.tv-viewer tune_channel <srvId>
// with high-speed D-Bus key injection fallback.

var fs = require('fs');
var path = require('path');

var DEFAULT_DATA_DIR = '/mnt/systemrw/tvs-chms/data';
var DEFAULT_TMP_DIR = '/tmp';
var ALLOWED_DBS = ['dvbs', 'sat', 'ipsrv', 'dvbt', 'dvbc'];
var SRVID_RE = /^-?[0-9]+$/;
var SAFE_IDENT_RE = /^[A-Za-z0-9_]+$/;
var MAX_CHANNEL_NAME_LEN = 60;
var CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

// Note: Samsung Tizen firmware intentionally spells this systemd unit "tvs_deamon.service"
// (verified on UA50AU7000 Tizen 6.0; "tvs_daemon.service" does not exist). Check both safely.
var TVS_UNIT_RESOLVE =
    'UNIT=""; ' +
    'if systemctl cat tvs_deamon.service >/dev/null 2>&1; then UNIT="tvs_deamon.service"; ' +
    'elif systemctl cat tvs_daemon.service >/dev/null 2>&1; then UNIT="tvs_daemon.service"; fi; ';

function createDict() {
    return Object.create(null);
}

function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
}

function shQuote(s) {
    return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function sqlPath(p) {
    return String(p).replace(/\\/g, '/').replace(/'/g, "''");
}

function sendJson(res, statusCode, obj) {
    res.writeHead(statusCode || 200, {
        'content-type': 'application/json',
        'cache-control': 'no-store'
    });
    res.end(JSON.stringify(obj));
}

function getServiceCategory(srvType) {
    var t = parseInt(srvType, 10);
    if (isNaN(t)) return 'tv';
    if (t === -1) return 'iptv';
    if (t === 1 || t === 17 || t === 22 || t === 25 || t === 31 || t === 32) return 'tv';
    if (t === 2 || t === 7 || t === 10) return 'radio';
    return 'data';
}

function rmrfSync(targetPath) {
    if (!targetPath) return;
    try {
        if (!fs.existsSync(targetPath)) return;
        var st = fs.lstatSync(targetPath);
        if (st.isDirectory() && !st.isSymbolicLink()) {
            var entries = fs.readdirSync(targetPath);
            for (var i = 0; i < entries.length; i++) {
                rmrfSync(path.join(targetPath, entries[i]));
            }
            fs.rmdirSync(targetPath);
        } else {
            fs.unlinkSync(targetPath);
        }
    } catch (e) { /* ignore cleanup error */ }
}

function decodeUtf16(raw) {
    if (!raw) return '';
    var chars = [];
    for (var i = 0; i < raw.length; i++) {
        var c = raw.charCodeAt(i);
        var chCode = ((c & 0xFF) << 8) | (c >> 8);
        if (chCode !== 0) {
            chars.push(String.fromCharCode(chCode));
        }
    }
    return chars.join('').trim();
}

function encodeUtf16Hex(str) {
    if (!str) return '';
    var hex = '';
    for (var i = 0; i < str.length; i++) {
        var code = str.charCodeAt(i);
        var high = (code >> 8) & 0xFF;
        var low = code & 0xFF;
        var hStr = high.toString(16);
        if (hStr.length < 2) hStr = '0' + hStr;
        var lStr = low.toString(16);
        if (lStr.length < 2) lStr = '0' + lStr;
        hex += hStr + lStr;
    }
    return hex;
}

function readJson(req, maxBytes, callback) {
    var limit = maxBytes || 8192;
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

    function onData(chunk) {
        body += chunk;
        if (Buffer.byteLength(body, 'utf8') > limit) {
            finish(new Error('payload too large (max ' + limit + ' bytes)'), null);
        }
    }

    function onEnd() {
        if (!body) {
            finish(null, {});
            return;
        }
        try {
            var data = JSON.parse(body);
            if (!data || typeof data !== 'object') {
                finish(new Error('invalid JSON payload'), null);
                return;
            }
            finish(null, data);
        } catch (e) {
            finish(new Error('invalid JSON format: ' + e.message), null);
        }
    }

    function onError(e) {
        finish(e || new Error('request error'), null);
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
}

function parseSrvIdList(arr) {
    var out = [];
    var seen = createDict();
    if (!Array.isArray(arr)) return out;
    for (var i = 0; i < arr.length; i++) {
        var raw = arr[i] != null ? String(arr[i]).trim() : '';
        if (raw && SRVID_RE.test(raw) && !hasOwn(seen, raw)) {
            seen[raw] = true;
            out.push(raw);
        }
    }
    return out;
}

// Reorder channels strictly by srvId while conserving slot count and optionally scoping
// displacement to a single DVB service category (TV vs Radio vs Data).
function computeChannelMoves(allChannels, selectedSrvIds, target, scopeByCategory) {
    var selectedSet = createDict();
    var validIds = parseSrvIdList(selectedSrvIds);
    for (var i = 0; i < validIds.length; i++) {
        selectedSet[validIds[i]] = true;
    }

    var matchedSelected = [];
    for (var j = 0; j < allChannels.length; j++) {
        var ch = allChannels[j];
        if (selectedSet[ch.srvId]) {
            matchedSelected.push(ch);
        }
    }

    var k = matchedSelected.length;
    if (k === 0) return { error: 'No matching channels selected' };
    if (isNaN(target) || target < 1 || target > 9999) {
        return { error: 'Target channel number must be between 1 and 9999' };
    }
    if (target + k - 1 > 9999) {
        return { error: 'Target range would exceed maximum channel number 9999' };
    }

    var targetCat = null;
    if (scopeByCategory) {
        targetCat = getServiceCategory(matchedSelected[0].srvType);
        for (var ci = 1; ci < matchedSelected.length; ci++) {
            if (getServiceCategory(matchedSelected[ci].srvType) !== targetCat) {
                return { error: 'Selected channels mix different service types (TV, Radio, or Data). Select one category to move.' };
            }
        }
    }

    var poolChannels = [];
    for (var pi = 0; pi < allChannels.length; pi++) {
        var item = allChannels[pi];
        if (!scopeByCategory || getServiceCategory(item.srvType) === targetCat) {
            poolChannels.push(item);
        }
    }

    var selected = [];
    var unselected = [];
    for (var si = 0; si < poolChannels.length; si++) {
        var pc = poolChannels[si];
        if (selectedSet[pc.srvId]) {
            selected.push(pc);
        } else {
            unselected.push(pc);
        }
    }

    function sortByMajorThenSrv(a, b) {
        if (a.major !== b.major) return a.major - b.major;
        return a.srvId < b.srvId ? -1 : (a.srvId > b.srvId ? 1 : 0);
    }

    selected.sort(sortByMajorThenSrv);
    unselected.sort(sortByMajorThenSrv);

    var currentSelectedNums = [];
    var targetSlots = [];
    for (var m = 0; m < k; m++) {
        currentSelectedNums.push(selected[m].major);
        targetSlots.push(target + m);
    }

    var isAlready = true;
    for (var n = 0; n < k; n++) {
        if (currentSelectedNums[n] !== targetSlots[n]) {
            isAlready = false;
            break;
        }
    }
    if (isAlready) {
        return {
            error: 'Selected channel(s) already occupy #' + target + (k > 1 ? (' - #' + (target + k - 1)) : '')
        };
    }

    var allSorted = poolChannels.slice().sort(sortByMajorThenSrv);
    var maxOrig = allSorted.length > 0 ? allSorted[allSorted.length - 1].major : 0;

    if (target > maxOrig) {
        var simpleChanges = [];
        for (var p = 0; p < k; p++) {
            simpleChanges.push({
                srvId: selected[p].srvId,
                oldMajor: selected[p].major,
                newMajor: target + p
            });
        }
        return { changes: simpleChanges };
    }

    var minInvolved = Math.min(currentSelectedNums[0], target);
    var maxInvolved = Math.max(currentSelectedNums[currentSelectedNums.length - 1], target + k - 1);

    var involvedUnselected = [];
    var occupiedSlotsMap = createDict();

    for (var q = 0; q < allSorted.length; q++) {
        var cItem = allSorted[q];
        if (cItem.major >= minInvolved && cItem.major <= maxInvolved) {
            occupiedSlotsMap[cItem.major] = true;
            if (!selectedSet[cItem.srvId]) {
                involvedUnselected.push(cItem);
            }
        }
    }

    for (var tIdx = 0; tIdx < targetSlots.length; tIdx++) {
        occupiedSlotsMap[targetSlots[tIdx]] = true;
    }

    var occupiedSlots = Object.keys(occupiedSlotsMap).map(function (s) {
        return parseInt(s, 10);
    });
    occupiedSlots.sort(function (a, b) { return a - b; });

    var targetSlotsSet = createDict();
    for (var ts = 0; ts < targetSlots.length; ts++) {
        targetSlotsSet[targetSlots[ts]] = true;
    }

    var unselectedSlots = [];
    for (var os = 0; os < occupiedSlots.length; os++) {
        if (!targetSlotsSet[occupiedSlots[os]]) {
            unselectedSlots.push(occupiedSlots[os]);
        }
    }

    var newAssignments = createDict();
    for (var sIdx = 0; sIdx < selected.length; sIdx++) {
        newAssignments[selected[sIdx].srvId] = targetSlots[sIdx];
    }
    for (var uIdx = 0; uIdx < involvedUnselected.length; uIdx++) {
        if (uIdx < unselectedSlots.length) {
            newAssignments[involvedUnselected[uIdx].srvId] = unselectedSlots[uIdx];
        }
    }

    var changes = [];
    for (var aIdx = 0; aIdx < allSorted.length; aIdx++) {
        var curCh = allSorted[aIdx];
        if (hasOwn(newAssignments, curCh.srvId) && newAssignments[curCh.srvId] !== curCh.major) {
            changes.push({
                srvId: curCh.srvId,
                oldMajor: curCh.major,
                newMajor: newAssignments[curCh.srvId]
            });
        }
    }

    return { changes: changes };
}

// Build pure deletion + optional category-scoped gap closure plan.
// Matches rows strictly by srvId (never major) and preserves hidden channel numbers.
function planDeleteAndCompact(dbChannels, delSrvIdSet, options) {
    var allowCompact = !!(options && options.allowCompact);
    var compact = !!(options && options.compact);

    var toDelete = [];
    var toKeep = [];
    for (var j = 0; j < dbChannels.length; j++) {
        var ch = dbChannels[j];
        if (hasOwn(delSrvIdSet, ch.srvId)) {
            toDelete.push(ch);
        } else {
            toKeep.push(ch);
        }
    }

    if (toDelete.length === 0) {
        return { toDelete: [], changes: [], remaining: dbChannels.length };
    }

    var changes = [];
    if (allowCompact && compact) {
        var affectedCats = createDict();
        for (var di = 0; di < toDelete.length; di++) {
            affectedCats[getServiceCategory(toDelete[di].srvType)] = true;
        }

        var catNames = Object.keys(affectedCats);
        for (var ci = 0; ci < catNames.length; ci++) {
            var cat = catNames[ci];
            var minBefore = null;
            for (var bi = 0; bi < dbChannels.length; bi++) {
                var row = dbChannels[bi];
                if (getServiceCategory(row.srvType) === cat && !row.hidden) {
                    if (minBefore === null || row.major < minBefore) {
                        minBefore = row.major;
                    }
                }
            }

            var visibleKeep = [];
            var reservedHidden = createDict();
            for (var ki = 0; ki < toKeep.length; ki++) {
                var kRow = toKeep[ki];
                if (getServiceCategory(kRow.srvType) !== cat) continue;
                if (kRow.hidden) {
                    reservedHidden[kRow.major] = true;
                } else {
                    visibleKeep.push(kRow);
                }
            }

            // Main DVB TV list compacts from 1; Radio/Data keep their pool start (or 1 if starting at 1).
            var nextMajor = (cat === 'tv' || minBefore === null || minBefore < 1) ? 1 : minBefore;
            for (var vi = 0; vi < visibleKeep.length; vi++) {
                while (reservedHidden[nextMajor]) {
                    nextMajor++;
                }
                if (visibleKeep[vi].major !== nextMajor) {
                    changes.push({
                        srvId: visibleKeep[vi].srvId,
                        oldMajor: visibleKeep[vi].major,
                        newMajor: nextMajor
                    });
                }
                nextMajor++;
            }
        }
    }

    return {
        toDelete: toDelete,
        changes: changes,
        remaining: toKeep.length
    };
}

function queryChannelsForEdit(ctx, dbPath, defaultSrvType) {
    var sql = 'PRAGMA busy_timeout = 5000; SELECT srvId, major, IFNULL(srvType, ' + defaultSrvType + '), IFNULL(hidden, 0) FROM SRV WHERE elim = 0 ORDER BY major ASC, srvId ASC;';
    var cmd = 'sqlite3 -bail ' + shQuote(dbPath) + ' ' + shQuote(sql);
    return ctx.execute(cmd, 10000).then(function (qRes) {
        if (qRes.exit_code !== 0) {
            return Promise.reject(new Error('Failed to query channels from ' + dbPath + ': ' + (qRes.stderr || 'exit code ' + qRes.exit_code)));
        }
        var lines = (qRes.stdout || '').split('\n');
        var rows = [];
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line) continue;
            var parts = line.split('|');
            if (parts.length < 2) continue;
            var srvIdStr = String(parts[0]).trim();
            var m = parseInt(parts[1], 10);
            var srvType = parts.length >= 3 ? parseInt(parts[2], 10) : defaultSrvType;
            var isHidden = parts.length >= 4 ? (String(parts[3]).trim() === '1') : false;
            if (SRVID_RE.test(srvIdStr) && !isNaN(m) && m > 0) {
                rows.push({
                    srvId: srvIdStr,
                    major: m,
                    srvType: isNaN(srvType) ? defaultSrvType : srvType,
                    hidden: isHidden
                });
            }
        }
        return rows;
    });
}

function runSqlFile(ctx, tmpRoot, dbPath, sqlParts, prefix, timeoutMs) {
    var tmpFile = path.join(tmpRoot, prefix + Date.now() + '_' + Math.random().toString(36).substr(2, 6) + '.sql');
    try {
        fs.writeFileSync(tmpFile, sqlParts.join('\n'), 'utf8');
    } catch (fsErr) {
        return Promise.reject(new Error('Failed to write temp SQL file: ' + fsErr.message));
    }
    var cmd = 'sqlite3 -bail ' + shQuote(dbPath) + ' < ' + shQuote(tmpFile) + '; RC=$?; rm -f ' + shQuote(tmpFile) + '; exit $RC';
    return ctx.execute(cmd, timeoutMs || 15000).then(function (res) {
        try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch (e) {}
        if (res.exit_code !== 0) {
            return Promise.reject(new Error('SQLite command failed on ' + dbPath + ': ' + (res.stderr || 'exit code ' + res.exit_code)));
        }
        return res;
    }, function (execErr) {
        try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch (e) {}
        return Promise.reject(execErr);
    });
}

function loadPage(ctx) {
    var places = [path.join(__dirname, 'ui.html'), path.join(ctx.dir || '', 'ui.html')];
    for (var i = 0; i < places.length; i++) {
        try { return fs.readFileSync(places[i], 'utf8'); } catch (e) { /* next */ }
    }
    return '<!doctype html><meta charset="utf-8"><p>Page file missing: reinstall this Shard.</p>';
}

var ALLOWED_KEYS = createDict();
ALLOWED_KEYS.vol_up = 'XF86AudioRaiseVolume';
ALLOWED_KEYS['vol+'] = 'XF86AudioRaiseVolume';
ALLOWED_KEYS.VolumeUp = 'XF86AudioRaiseVolume';
ALLOWED_KEYS.XF86AudioRaiseVolume = 'XF86AudioRaiseVolume';
ALLOWED_KEYS.vol_down = 'XF86AudioLowerVolume';
ALLOWED_KEYS['vol-'] = 'XF86AudioLowerVolume';
ALLOWED_KEYS.VolumeDown = 'XF86AudioLowerVolume';
ALLOWED_KEYS.XF86AudioLowerVolume = 'XF86AudioLowerVolume';
ALLOWED_KEYS.mute = 'XF86AudioMute';
ALLOWED_KEYS.XF86AudioMute = 'XF86AudioMute';
ALLOWED_KEYS.ch_up = 'XF86RaiseChannel';
ALLOWED_KEYS['ch+'] = 'XF86RaiseChannel';
ALLOWED_KEYS.ChannelUp = 'XF86RaiseChannel';
ALLOWED_KEYS.XF86RaiseChannel = 'XF86RaiseChannel';
ALLOWED_KEYS.ch_down = 'XF86LowerChannel';
ALLOWED_KEYS['ch-'] = 'XF86LowerChannel';
ALLOWED_KEYS.ChannelDown = 'XF86LowerChannel';
ALLOWED_KEYS.XF86LowerChannel = 'XF86LowerChannel';
ALLOWED_KEYS.exit = 'XF86Exit';
ALLOWED_KEYS.XF86Exit = 'XF86Exit';

module.exports = function (ctx) {
    var page = null;
    var cachedChannels = null;
    var lastFetchTime = 0;
    var dbBusy = false;
    var pendingReload = false;
    var dataDir = (ctx && ctx._dataDir) ? String(ctx._dataDir) : DEFAULT_DATA_DIR;
    var tmpRoot = (ctx && ctx._tmpDir) ? String(ctx._tmpDir) : DEFAULT_TMP_DIR;
    var lockFile = path.join(tmpRoot, 'vetro_channels_db.lock');

    function withDbLock(res, actionFn) {
        if (dbBusy) {
            sendJson(res, 409, { ok: false, error: 'Another database modification is in progress. Please wait.' });
            return;
        }
        dbBusy = true;
        var released = false;
        function release() {
            if (!released) {
                released = true;
                dbBusy = false;
            }
        }
        try {
            actionFn(release);
        } catch (err) {
            release();
            sendJson(res, 500, { ok: false, error: err.message });
        }
    }

    function queryDatabase() {
        var dvbsPath = path.join(dataDir, 'dvbs');
        var satPath = path.join(dataDir, 'sat');
        var ipsrvPath = path.join(dataDir, 'ipsrv');

        var sqlWithSat = 'PRAGMA busy_timeout = 3000; ' +
            "ATTACH '" + sqlPath(satPath) + "' AS sat_db; " +
            "SELECT S.major, S.srvName, IFNULL(T.tpFreq/1000, 0), IFNULL(T.tpPol, -1), IFNULL(T.tpSr, 0), IFNULL(SAT.satName, ''), S.scrambled, S.hidden, S.srvId, IFNULL(S.srvType, 1) " +
            'FROM SRV S ' +
            'LEFT JOIN CHNL C ON S.chId = C.chId ' +
            'LEFT JOIN sat_db.SAT_TP T ON C.chNum = T.tpId ' +
            'LEFT JOIN sat_db.SAT SAT ON T.satId = SAT.satId ' +
            'WHERE S.elim = 0 ' +
            'ORDER BY S.major ASC, S.srvId ASC;';

        var sqlNoSat = 'PRAGMA busy_timeout = 3000; ' +
            "SELECT major, srvName, 0, -1, 0, '', scrambled, hidden, srvId, IFNULL(srvType, 1) " +
            'FROM SRV WHERE elim = 0 ORDER BY major ASC, srvId ASC;';

        var cmd = 'sh -c ' + shQuote(
            'DB=' + shQuote(dvbsPath) + '; SAT=' + shQuote(satPath) + '; ' +
            'if [ ! -f "$DB" ]; then echo "__NO_DB__"; exit 0; fi; ' +
            'if [ -f "$SAT" ]; then sqlite3 -bail "$DB" ' + shQuote(sqlWithSat) + '; ' +
            'else sqlite3 -bail "$DB" ' + shQuote(sqlNoSat) + '; fi'
        );

        return ctx.execute(cmd, 10000).then(function (res) {
            if (res.exit_code !== 0) {
                return Promise.reject(new Error('Failed to query satellite channels: ' + (res.stderr || 'sqlite exit code ' + res.exit_code)));
            }

            var channels = [];
            var stdout = res.stdout || '';
            if (stdout && stdout.indexOf('__NO_DB__') < 0) {
                var lines = stdout.split('\n');
                for (var i = 0; i < lines.length; i++) {
                    var line = lines[i];
                    if (!line) continue;
                    var parts = line.split('|');
                    if (parts.length < 9) continue;
                    var major = parseInt(parts[0], 10);
                    if (isNaN(major)) continue;
                    var name = decodeUtf16(parts[1]);
                    var freq = parseInt(parts[2], 10) || 0;
                    var polRaw = parts[3];
                    var pol = polRaw === '0' ? 'H' : (polRaw === '1' ? 'V' : '');
                    var sr = parseInt(parts[4], 10) || 0;
                    var sat = decodeUtf16(parts[5]);
                    var scrambled = parts[6] === '1';
                    var hidden = parts[7] === '1';
                    var srvId = parts[8] ? String(parts[8]).trim() : '';
                    var srvType = parts.length >= 10 ? parseInt(parts[9], 10) : 1;
                    if (isNaN(srvType)) srvType = 1;

                    channels.push({
                        num: major,
                        name: name,
                        freq: freq,
                        pol: pol,
                        sr: sr,
                        sat: sat || 'Satellite',
                        type: 'dvbs',
                        srvType: srvType,
                        category: getServiceCategory(srvType),
                        scrambled: scrambled,
                        hidden: hidden,
                        srvId: srvId
                    });
                }
            }

            // Also query IPTV (Samsung TV Plus) from ipsrv
            var sqlIp = 'PRAGMA busy_timeout = 3000; SELECT major, srvName, hidden, srvId, IFNULL(srvType, -1) FROM SRV WHERE elim = 0 ORDER BY major ASC, srvId ASC;';
            var cmdIp = 'sh -c ' + shQuote(
                'DB=' + shQuote(ipsrvPath) + '; ' +
                'if [ ! -f "$DB" ]; then echo "__NO_DB__"; exit 0; fi; ' +
                'sqlite3 -bail "$DB" ' + shQuote(sqlIp)
            );

            return ctx.execute(cmdIp, 5000).then(function (resIp) {
                if (resIp.exit_code !== 0) {
                    return Promise.reject(new Error('Failed to query IPTV channels: ' + (resIp.stderr || 'sqlite exit code ' + resIp.exit_code)));
                }
                var outIp = resIp.stdout || '';
                if (outIp && outIp.indexOf('__NO_DB__') < 0) {
                    var linesIp = outIp.split('\n');
                    for (var j = 0; j < linesIp.length; j++) {
                        var l = linesIp[j];
                        if (!l) continue;
                        var p = l.split('|');
                        if (p.length < 4) continue;
                        var m = parseInt(p[0], 10);
                        if (isNaN(m)) continue;
                        var ipSrvId = p[3] ? String(p[3]).trim() : '';
                        var ipSrvType = p.length >= 5 ? parseInt(p[4], 10) : -1;
                        if (isNaN(ipSrvType)) ipSrvType = -1;
                        channels.push({
                            num: m,
                            name: decodeUtf16(p[1]),
                            freq: 0,
                            pol: '',
                            sr: 0,
                            sat: 'Samsung TV Plus',
                            type: 'iptv',
                            srvType: ipSrvType,
                            category: 'iptv',
                            scrambled: false,
                            hidden: p[2] === '1',
                            srvId: ipSrvId
                        });
                    }
                }

                cachedChannels = channels;
                lastFetchTime = Date.now();
                return channels;
            });
        });
    }

    return {
        start: function () {
            page = loadPage(ctx);
        },

        stop: function () {
            page = null;
            cachedChannels = null;
            lastFetchTime = 0;
            dbBusy = false;
            pendingReload = false;
        },

        status: function () {
            return {
                ok: true,
                count: cachedChannels ? cachedChannels.length : 0,
                pendingReload: pendingReload
            };
        },

        route: function (req, res, sub) {
            var action = (sub || '').split('?')[0];

            // GET api/ui
            if (action === 'ui' && req.method === 'GET') {
                if (!page) page = loadPage(ctx);
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
                res.end(page || '');
                return true;
            }

            // GET api/list
            if (action === 'list' && req.method === 'GET') {
                var forceRefresh = req.url && req.url.indexOf('refresh=1') >= 0;
                if (!forceRefresh && cachedChannels && (Date.now() - lastFetchTime < 3000)) {
                    sendJson(res, 200, { ok: true, channels: cachedChannels, pendingReload: pendingReload });
                    return true;
                }

                queryDatabase()
                    .then(function (channels) {
                        sendJson(res, 200, { ok: true, channels: channels, pendingReload: pendingReload });
                    }, function (err) {
                        sendJson(res, 500, { ok: false, error: err.message });
                    });
                return true;
            }

            // POST api/tune — switch TV to selected channel number or direct srvId
            if ((sub === 'tune' || action === 'tune') && req.method === 'POST') {
                readJson(req, 4096, function (err, parsed) {
                    if (err) {
                        sendJson(res, 400, { ok: false, error: err.message });
                        return;
                    }

                    var channel = parseInt(parsed.channel, 10);
                    var srvId = parsed.srvId != null ? String(parsed.srvId).trim() : null;
                    var forceTv = !!parsed.forceTv;

                    // If srvId wasn't provided in the request body, look it up in cachedChannels
                    if (!srvId && cachedChannels && channel) {
                        for (var c = 0; c < cachedChannels.length; c++) {
                            if (cachedChannels[c].num === channel && cachedChannels[c].srvId) {
                                srvId = cachedChannels[c].srvId;
                                break;
                            }
                        }
                    }

                    // METHOD 1: Instant Direct Tune via srvId (0ms delay, no digit entry)
                    if (srvId && SRVID_RE.test(srvId)) {
                        var launchCmd = '/usr/bin/launch_app org.tizen.tv-viewer tune_channel ' + srvId;
                        ctx.execute(launchCmd, 4000).then(function (r) {
                            sendJson(res, 200, { ok: r.exit_code === 0, channel: channel, srvId: srvId, method: 'direct' });
                        }, function (e) {
                            sendJson(res, 500, { ok: false, error: e.message });
                        });
                        return;
                    }

                    // METHOD 2 (Fallback): High-Speed Async D-Bus Key Injection
                    if (!channel || isNaN(channel) || channel <= 0) {
                        sendJson(res, 400, { ok: false, error: 'invalid channel number or srvId' });
                        return;
                    }

                    var digits = String(channel).split('');
                    var keyCmds = [];

                    if (forceTv) {
                        keyCmds.push('dbus-send --system --type=method_call --dest=org.enlightenment.wm /org/enlightenment/wm org.enlightenment.wm.Test.EventKey uint32:1 string:XF86TV');
                        keyCmds.push('dbus-send --system --type=method_call --dest=org.enlightenment.wm /org/enlightenment/wm org.enlightenment.wm.Test.EventKey uint32:0 string:XF86TV');
                        keyCmds.push('sleep 0.5');
                    }

                    for (var d = 0; d < digits.length; d++) {
                        keyCmds.push('dbus-send --system --type=method_call --dest=org.enlightenment.wm /org/enlightenment/wm org.enlightenment.wm.Test.EventKey uint32:1 string:"' + digits[d] + '"');
                        keyCmds.push('dbus-send --system --type=method_call --dest=org.enlightenment.wm /org/enlightenment/wm org.enlightenment.wm.Test.EventKey uint32:0 string:"' + digits[d] + '"');
                        if (d < digits.length - 1) {
                            keyCmds.push('sleep 0.05');
                        }
                    }
                    keyCmds.push('sleep 0.05');
                    keyCmds.push('dbus-send --system --type=method_call --dest=org.enlightenment.wm /org/enlightenment/wm org.enlightenment.wm.Test.EventKey uint32:1 string:Return');
                    keyCmds.push('dbus-send --system --type=method_call --dest=org.enlightenment.wm /org/enlightenment/wm org.enlightenment.wm.Test.EventKey uint32:0 string:Return');

                    var fullCmd = keyCmds.join('; ');

                    ctx.execute(fullCmd, 6000).then(function (r) {
                        sendJson(res, 200, { ok: r.exit_code === 0, channel: channel, method: 'keys', stderr: r.stderr });
                    }, function (e) {
                        sendJson(res, 500, { ok: false, error: e.message });
                    });
                });
                return true;
            }

            // POST api/tvsource — switch input directly to Broadcast TV
            if ((sub === 'tvsource' || action === 'tvsource') && req.method === 'POST') {
                var switchCmd = 'sh -c "/usr/bin/input_keyevent XF86Exit; /usr/bin/launch_app org.tizen.tv-viewer change_source 0 sourceType 0 sourceName TV mbrIndex -2 __K_EX_LAUNCH_REQUESTOR user"';
                ctx.execute(switchCmd, 6000).then(function (r) {
                    sendJson(res, 200, { ok: r.exit_code === 0 });
                }, function (e) {
                    sendJson(res, 500, { ok: false, error: e.message });
                });
                return true;
            }

            // POST api/reload — reload channel manager daemon without forcing input source switch
            if ((sub === 'reload' || action === 'reload') && req.method === 'POST') {
                withDbLock(res, function (release) {
                    var reloadScript =
                        'exec 9>' + shQuote(lockFile) + '; ' +
                        '/usr/bin/flock -n 9 || { echo "LOCKED"; exit 10; }; ' +
                        TVS_UNIT_RESOLVE +
                        'if [ -n "$UNIT" ]; then systemctl restart "$UNIT"; else pkill -9 tvs-daemon || true; fi && sleep 1';
                    ctx.execute('sh -c ' + shQuote(reloadScript), 8000).then(function (r) {
                        release();
                        if (r.exit_code === 10 || (r.stdout || '').indexOf('LOCKED') >= 0) {
                            sendJson(res, 409, { ok: false, error: 'Database lock held by another operation. Please retry.' });
                            return;
                        }
                        if (r.exit_code !== 0) {
                            sendJson(res, 500, { ok: false, error: 'Reload failed: ' + (r.stderr || 'exit code ' + r.exit_code) });
                            return;
                        }
                        cachedChannels = null;
                        pendingReload = false;
                        sendJson(res, 200, { ok: true, pendingReload: pendingReload });
                    }, function (e) {
                        release();
                        sendJson(res, 500, { ok: false, error: e.message });
                    });
                });
                return true;
            }

            // POST api/key — send key event (e.g. Vol+, Vol-, CH+, CH-)
            if ((sub === 'key' || action === 'key') && req.method === 'POST') {
                readJson(req, 4096, function (err, parsed) {
                    if (err) {
                        sendJson(res, 400, { ok: false, error: err.message });
                        return;
                    }
                    var k = parsed.key;
                    var keySym = (typeof k === 'string' && hasOwn(ALLOWED_KEYS, k) && typeof ALLOWED_KEYS[k] === 'string')
                        ? ALLOWED_KEYS[k]
                        : null;

                    if (!keySym) {
                        sendJson(res, 400, { ok: false, error: 'Invalid key' });
                        return;
                    }

                    ctx.execute('/usr/bin/input_keyevent ' + keySym, 3000).then(function (r) {
                        sendJson(res, 200, { ok: r.exit_code === 0, key: keySym });
                    }, function (e) {
                        sendJson(res, 500, { ok: false, error: e.message });
                    });
                });
                return true;
            }

            // POST api/edit — manage channels strictly by srvId (hide, unhide, delete, move, rename)
            if ((sub === 'edit' || action === 'edit') && req.method === 'POST') {
                readJson(req, 65536, function (err, parsed) {
                    if (err) {
                        sendJson(res, 400, { ok: false, error: err.message });
                        return;
                    }

                    withDbLock(res, function (release) {
                        var editAction = parsed.action;
                        var dvbsSrvIds = [];
                        var ipsrvSrvIds = [];

                        if (Array.isArray(parsed.dvbsSrvIds) || Array.isArray(parsed.ipsrvSrvIds)) {
                            dvbsSrvIds = parseSrvIdList(parsed.dvbsSrvIds);
                            ipsrvSrvIds = parseSrvIdList(parsed.ipsrvSrvIds);
                        } else {
                            var singleList = [];
                            if (Array.isArray(parsed.srvIds)) {
                                singleList = parseSrvIdList(parsed.srvIds);
                            } else if (parsed.srvId != null) {
                                singleList = parseSrvIdList([parsed.srvId]);
                            }
                            if (parsed.type === 'ipsrv') {
                                ipsrvSrvIds = singleList;
                            } else {
                                dvbsSrvIds = singleList;
                            }
                        }

                        var totalChannels = dvbsSrvIds.length + ipsrvSrvIds.length;
                        if (!editAction || totalChannels === 0) {
                            release();
                            sendJson(res, 400, { ok: false, error: 'missing action or valid srvIds' });
                            return;
                        }

                        var dvbsPath = path.join(dataDir, 'dvbs');
                        var ipsrvPath = path.join(dataDir, 'ipsrv');

                        // ACTION 1: DELETE (pure deletion by default; optional category-scoped gap closure on dvbs;
                        // uses single ATTACH transaction when deleting from both dvbs and ipsrv)
                        if (editAction === 'delete') {
                            var compactRequested = !!parsed.compact;
                            var dvbsDelSet = createDict();
                            for (var di = 0; di < dvbsSrvIds.length; di++) dvbsDelSet[dvbsSrvIds[di]] = true;
                            var ipsrvDelSet = createDict();
                            for (var ipi = 0; ipi < ipsrvSrvIds.length; ipi++) ipsrvDelSet[ipsrvSrvIds[ipi]] = true;

                            var pDvbs = dvbsSrvIds.length > 0 ? queryChannelsForEdit(ctx, dvbsPath, 1) : Promise.resolve([]);
                            var pIpsrv = ipsrvSrvIds.length > 0 ? queryChannelsForEdit(ctx, ipsrvPath, -1) : Promise.resolve([]);

                            Promise.all([pDvbs, pIpsrv]).then(function (results) {
                                var dvbsPlan = planDeleteAndCompact(results[0], dvbsDelSet, {
                                    allowCompact: true,
                                    compact: compactRequested
                                });
                                // Never compact Samsung TV Plus (ipsrv) numbers (they live in 4000+ range).
                                var ipPlan = planDeleteAndCompact(results[1], ipsrvDelSet, {
                                    allowCompact: false,
                                    compact: false
                                });

                                var totalDeleted = dvbsPlan.toDelete.length + ipPlan.toDelete.length;
                                var totalShifted = dvbsPlan.changes.length;
                                if (totalDeleted === 0) {
                                    release();
                                    sendJson(res, 200, {
                                        ok: true,
                                        action: 'delete',
                                        deleted: 0,
                                        shifted: 0,
                                        pendingReload: pendingReload
                                    });
                                    return;
                                }

                                function appendPlanSql(parts, tableRef, planObj) {
                                    var delIds = [];
                                    for (var x = 0; x < planObj.toDelete.length; x++) delIds.push(planObj.toDelete[x].srvId);
                                    parts.push('UPDATE ' + tableRef + ' SET elim = 1, hidden = 1, hideGuide = 1, numSel = 0, major = 0 WHERE srvId IN (' + delIds.join(',') + ') AND elim = 0;');
                                    if (planObj.changes.length > 0) {
                                        var cases = [];
                                        var chgIds = [];
                                        for (var y = 0; y < planObj.changes.length; y++) {
                                            cases.push('WHEN ' + planObj.changes[y].srvId + ' THEN ' + planObj.changes[y].newMajor);
                                            chgIds.push(planObj.changes[y].srvId);
                                        }
                                        parts.push('UPDATE ' + tableRef + ' SET major = CASE srvId ' + cases.join(' ') + ' END, modifiedByUser = 1 WHERE srvId IN (' + chgIds.join(',') + ') AND elim = 0;');
                                    }
                                }

                                var sqlParts = [
                                    '.bail on',
                                    '.timeout 5000',
                                    'PRAGMA busy_timeout = 5000;'
                                ];
                                var targetExecDb;
                                var both = dvbsPlan.toDelete.length > 0 && ipPlan.toDelete.length > 0;
                                if (both) {
                                    targetExecDb = dvbsPath;
                                    sqlParts.push("ATTACH '" + sqlPath(ipsrvPath) + "' AS ipsrv_db;");
                                    sqlParts.push('BEGIN IMMEDIATE;');
                                    appendPlanSql(sqlParts, 'main.SRV', dvbsPlan);
                                    appendPlanSql(sqlParts, 'ipsrv_db.SRV', ipPlan);
                                    sqlParts.push('COMMIT;');
                                    sqlParts.push('PRAGMA main.wal_checkpoint(TRUNCATE);');
                                    sqlParts.push('PRAGMA ipsrv_db.wal_checkpoint(TRUNCATE);');
                                } else if (dvbsPlan.toDelete.length > 0) {
                                    targetExecDb = dvbsPath;
                                    sqlParts.push('BEGIN IMMEDIATE;');
                                    appendPlanSql(sqlParts, 'SRV', dvbsPlan);
                                    sqlParts.push('COMMIT;');
                                    sqlParts.push('PRAGMA wal_checkpoint(TRUNCATE);');
                                } else {
                                    targetExecDb = ipsrvPath;
                                    sqlParts.push('BEGIN IMMEDIATE;');
                                    appendPlanSql(sqlParts, 'SRV', ipPlan);
                                    sqlParts.push('COMMIT;');
                                    sqlParts.push('PRAGMA wal_checkpoint(TRUNCATE);');
                                }

                                return runSqlFile(ctx, tmpRoot, targetExecDb, sqlParts, 'ch_del_', 15000).then(function () {
                                    release();
                                    cachedChannels = null;
                                    pendingReload = true;
                                    sendJson(res, 200, {
                                        ok: true,
                                        action: 'delete',
                                        deleted: totalDeleted,
                                        shifted: totalShifted,
                                        pendingReload: pendingReload
                                    });
                                });
                            }).then(null, function (delErr) {
                                release();
                                sendJson(res, 500, { ok: false, error: delErr.message });
                            });
                            return;
                        }

                        // ACTION 2: MOVE channel(s) strictly by srvId with slot-conserving displacement
                        if (editAction === 'move') {
                            if (dvbsSrvIds.length > 0 && ipsrvSrvIds.length > 0) {
                                release();
                                sendJson(res, 400, { ok: false, error: 'cannot move Satellite and TV Plus channels together' });
                                return;
                            }
                            var targetType = (parsed.type === 'ipsrv' || ipsrvSrvIds.length > 0) ? 'ipsrv' : 'dvbs';
                            var moveDbPath = targetType === 'ipsrv' ? ipsrvPath : dvbsPath;
                            var moveSrvIds = targetType === 'ipsrv' ? ipsrvSrvIds : dvbsSrvIds;
                            var defaultCatType = targetType === 'ipsrv' ? -1 : 1;
                            var target = parseInt(parsed.target, 10);
                            if (isNaN(target) || target < 1 || target > 9999) {
                                release();
                                sendJson(res, 400, { ok: false, error: 'target channel must be between 1 and 9999' });
                                return;
                            }

                            queryChannelsForEdit(ctx, moveDbPath, defaultCatType)
                                .then(function (dbChannels) {
                                    var plan = computeChannelMoves(dbChannels, moveSrvIds, target, targetType === 'dvbs');
                                    if (plan.error) {
                                        release();
                                        sendJson(res, 400, { ok: false, error: plan.error });
                                        return;
                                    }

                                    var changes = plan.changes || [];
                                    if (changes.length === 0) {
                                        release();
                                        sendJson(res, 200, { ok: true, action: 'move', changed: 0, message: 'Channels are already at the target location', pendingReload: pendingReload });
                                        return;
                                    }

                                    var caseParts = [];
                                    var srvIdList = [];
                                    for (var c = 0; c < changes.length; c++) {
                                        caseParts.push('WHEN ' + changes[c].srvId + ' THEN ' + changes[c].newMajor);
                                        srvIdList.push(changes[c].srvId);
                                    }

                                    var moveParts = [
                                        '.bail on',
                                        '.timeout 5000',
                                        'PRAGMA busy_timeout = 5000;',
                                        'BEGIN IMMEDIATE;',
                                        'UPDATE SRV SET major = CASE srvId ' + caseParts.join(' ') + ' END, modifiedByUser = 1 WHERE srvId IN (' + srvIdList.join(',') + ') AND elim = 0;',
                                        'COMMIT;',
                                        'PRAGMA wal_checkpoint(TRUNCATE);'
                                    ];

                                    return runSqlFile(ctx, tmpRoot, moveDbPath, moveParts, 'ch_mv_', 15000).then(function () {
                                        release();
                                        cachedChannels = null;
                                        pendingReload = true;
                                        sendJson(res, 200, {
                                            ok: true,
                                            action: 'move',
                                            target: target,
                                            moved: moveSrvIds.length,
                                            changed: changes.length,
                                            changes: changes,
                                            pendingReload: pendingReload
                                        });
                                    });
                                })
                                .then(null, function (mvErr) {
                                    release();
                                    sendJson(res, 500, { ok: false, error: mvErr.message });
                                });
                            return;
                        }

                        // ACTION 3: HIDE / UNHIDE strictly by srvId (atomic ATTACH when spanning both DBs)
                        if (editAction === 'hide' || editAction === 'unhide') {
                            var hideVal = editAction === 'hide' ? 1 : 0;
                            var numSelVal = editAction === 'hide' ? 0 : 1;
                            var visParts = [
                                '.bail on',
                                '.timeout 5000',
                                'PRAGMA busy_timeout = 5000;'
                            ];
                            var visDb;
                            if (dvbsSrvIds.length > 0 && ipsrvSrvIds.length > 0) {
                                visDb = dvbsPath;
                                visParts.push("ATTACH '" + sqlPath(ipsrvPath) + "' AS ipsrv_db;");
                                visParts.push('BEGIN IMMEDIATE;');
                                visParts.push('UPDATE main.SRV SET hidden = ' + hideVal + ', hideGuide = ' + hideVal + ', numSel = ' + numSelVal + ' WHERE srvId IN (' + dvbsSrvIds.join(',') + ') AND elim = 0;');
                                visParts.push('UPDATE ipsrv_db.SRV SET hidden = ' + hideVal + ', hideGuide = ' + hideVal + ', numSel = ' + numSelVal + ' WHERE srvId IN (' + ipsrvSrvIds.join(',') + ') AND elim = 0;');
                                visParts.push('COMMIT;');
                                visParts.push('PRAGMA main.wal_checkpoint(TRUNCATE);');
                                visParts.push('PRAGMA ipsrv_db.wal_checkpoint(TRUNCATE);');
                            } else {
                                visDb = dvbsSrvIds.length > 0 ? dvbsPath : ipsrvPath;
                                var visIds = dvbsSrvIds.length > 0 ? dvbsSrvIds : ipsrvSrvIds;
                                visParts.push('BEGIN IMMEDIATE;');
                                visParts.push('UPDATE SRV SET hidden = ' + hideVal + ', hideGuide = ' + hideVal + ', numSel = ' + numSelVal + ' WHERE srvId IN (' + visIds.join(',') + ') AND elim = 0;');
                                visParts.push('COMMIT;');
                                visParts.push('PRAGMA wal_checkpoint(TRUNCATE);');
                            }

                            runSqlFile(ctx, tmpRoot, visDb, visParts, 'ch_vis_', 12000).then(function () {
                                release();
                                cachedChannels = null;
                                pendingReload = true;
                                sendJson(res, 200, {
                                    ok: true,
                                    action: editAction,
                                    count: totalChannels,
                                    pendingReload: pendingReload
                                });
                            }, function (uErr) {
                                release();
                                sendJson(res, 500, { ok: false, error: uErr.message });
                            });
                            return;
                        }

                        // ACTION 4: RENAME strictly by srvId (no major fallback)
                        if (editAction === 'rename') {
                            var newName = (parsed.name || '').trim();
                            if (!newName) {
                                release();
                                sendJson(res, 400, { ok: false, error: 'missing channel name' });
                                return;
                            }
                            if (newName.length > MAX_CHANNEL_NAME_LEN || CONTROL_CHAR_RE.test(newName)) {
                                release();
                                sendJson(res, 400, { ok: false, error: 'channel name must be 1-' + MAX_CHANNEL_NAME_LEN + ' printable characters' });
                                return;
                            }
                            var renameTargetType = (parsed.type === 'ipsrv' || ipsrvSrvIds.length > 0) ? 'ipsrv' : 'dvbs';
                            var renameDbPath = renameTargetType === 'ipsrv' ? ipsrvPath : dvbsPath;
                            var srvIdStr = renameTargetType === 'ipsrv'
                                ? (ipsrvSrvIds.length > 0 ? ipsrvSrvIds[0] : '')
                                : (dvbsSrvIds.length > 0 ? dvbsSrvIds[0] : '');

                            if (!srvIdStr || !SRVID_RE.test(srvIdStr)) {
                                release();
                                sendJson(res, 400, { ok: false, error: 'missing valid channel srvId' });
                                return;
                            }

                            var hexName = encodeUtf16Hex(newName);
                            var renameParts = [
                                '.bail on',
                                '.timeout 5000',
                                'PRAGMA busy_timeout = 5000;',
                                'BEGIN IMMEDIATE;',
                                "UPDATE SRV SET srvName = CAST(X'" + hexName + "' AS TEXT), modifiedByUser = 1 WHERE srvId = " + srvIdStr + ' AND elim = 0;',
                                'COMMIT;',
                                'PRAGMA wal_checkpoint(TRUNCATE);'
                            ];
                            runSqlFile(ctx, tmpRoot, renameDbPath, renameParts, 'ch_ren_', 10000).then(function () {
                                release();
                                cachedChannels = null;
                                pendingReload = true;
                                sendJson(res, 200, {
                                    ok: true,
                                    action: 'rename',
                                    srvId: srvIdStr,
                                    count: 1,
                                    pendingReload: pendingReload
                                });
                            }, function (e) {
                                release();
                                sendJson(res, 500, { ok: false, error: e.message });
                            });
                            return;
                        }

                        release();
                        sendJson(res, 400, { ok: false, error: 'unsupported action' });
                    });
                });
                return true;
            }

            // GET api/export — export official Samsung Channel_list_<Version>.zip under DB lock
            // Includes metadata.xml only if it already exists on this TV (no hardcoded country codes).
            if ((sub === 'export' || action === 'export') && req.method === 'GET') {
                withDbLock(res, function (release) {
                    var expId = Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 6);
                    var tmpZipPath = path.join(tmpRoot, 'ch_exp_' + expId + '.zip');
                    var exportCmd = 'sh -c ' + shQuote(
                        'PRD="/etc/prd_info.ini"; ' +
                        'VER=""; ' +
                        'if [ -f "$PRD" ]; then VER=$(grep -i "^Version=" "$PRD" | head -n 1 | cut -d "=" -f2 | tr -d ";\\r\\n "); fi; ' +
                        'if [ -z "$VER" ]; then VER="backup"; fi; ' +
                        'ZIPNAME="Channel_list_${VER}.zip"; ' +
                        'ZIPPATH=' + shQuote(tmpZipPath) + '; ' +
                        'cd ' + shQuote(dataDir) + ' || exit 1; ' +
                        'FILES=""; ' +
                        'for f in dvbs sat ipsrv dvbt dvbc; do ' +
                        '  if [ -f "$f" ]; then sqlite3 -bail "$f" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null 2>&1 || true; FILES="$FILES $f"; fi; ' +
                        'done; ' +
                        'if [ -f "metadata.xml" ]; then FILES="$FILES metadata.xml"; fi; ' +
                        'if [ -z "$FILES" ]; then echo "NO_FILES"; exit 2; fi; ' +
                        'rm -f "$ZIPPATH"; ' +
                        '/usr/bin/zip -j "$ZIPPATH" $FILES >/dev/null 2>&1 || exit 3; ' +
                        'echo "$ZIPNAME"'
                    );

                    ctx.execute(exportCmd, 12000).then(function (r) {
                        // Snapshot file is complete on disk: release lock before streaming over slow links.
                        release();
                        var lines = (r.stdout || '').trim().split('\n');
                        var lastLine = lines.length > 0 ? lines[lines.length - 1].trim() : '';
                        if (r.exit_code !== 0 || lastLine === 'NO_FILES') {
                            try { if (fs.existsSync(tmpZipPath)) fs.unlinkSync(tmpZipPath); } catch (e) {}
                            sendJson(res, 500, { ok: false, error: 'Failed to generate channel backup archive' });
                            return;
                        }
                        var zipName = lastLine.replace(/[^A-Za-z0-9._-]/g, '');
                        if (!zipName || zipName.indexOf('Channel_list_') !== 0) {
                            zipName = 'Channel_list_backup.zip';
                        }
                        try {
                            var stat = fs.statSync(tmpZipPath);
                            res.writeHead(200, {
                                'content-type': 'application/zip',
                                'content-disposition': 'attachment; filename="' + zipName + '"',
                                'content-length': stat.size,
                                'cache-control': 'no-store'
                            });
                            var cleaned = false;
                            function cleanupZip() {
                                if (cleaned) return;
                                cleaned = true;
                                try { if (fs.existsSync(tmpZipPath)) fs.unlinkSync(tmpZipPath); } catch (e) {}
                            }
                            var readStream = fs.createReadStream(tmpZipPath);
                            readStream.on('close', cleanupZip);
                            readStream.on('error', function () {
                                cleanupZip();
                                try { res.end(); } catch (e) {}
                            });
                            res.on('close', cleanupZip);
                            readStream.pipe(res);
                        } catch (fsErr) {
                            try { if (fs.existsSync(tmpZipPath)) fs.unlinkSync(tmpZipPath); } catch (e) {}
                            sendJson(res, 500, { ok: false, error: 'Backup archive could not be read: ' + fsErr.message });
                        }
                    }, function (e) {
                        release();
                        try { if (fs.existsSync(tmpZipPath)) fs.unlinkSync(tmpZipPath); } catch (ex) {}
                        sendJson(res, 500, { ok: false, error: e.message });
                    });
                });
                return true;
            }

            // POST api/import — import Samsung Channel_list_*.zip archive
            if ((sub === 'import' || action === 'import') && req.method === 'POST') {
                withDbLock(res, function (release) {
                    var importId = Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 6);
                    var uploadZip = '/tmp/ch_up_' + importId + '.zip';
                    var tmpDir = '/tmp/ch_imp_' + importId;
                    var bakDir = '/tmp/ch_bak_' + importId;

                    var MAX_IMPORT_BYTES = 15 * 1024 * 1024; // 15 MB cap
                    var receivedBytes = 0;
                    var outStream = fs.createWriteStream(uploadZip);
                    var exceeded = false;

                    req.on('data', function (chunk) {
                        receivedBytes += chunk.length;
                        if (receivedBytes > MAX_IMPORT_BYTES) {
                            exceeded = true;
                            req.destroy();
                            outStream.destroy();
                            try { fs.unlinkSync(uploadZip); } catch (e) {}
                        }
                    });

                    req.pipe(outStream);

                    outStream.on('finish', function () {
                        if (exceeded) {
                            release();
                            res.writeHead(413, { 'content-type': 'application/json' });
                            res.end(JSON.stringify({ ok: false, error: 'Archive exceeds 15 MB limit.' }));
                            return;
                        }

                        var importCmd = 'sh -c \'' +
                            'if ! /usr/bin/unzip -t "' + uploadZip + '" >/dev/null 2>&1; then ' +
                            '  rm -f "' + uploadZip + '"; echo "INVALID_ZIP"; exit 1; ' +
                            'fi; ' +
                            'rm -rf "' + tmpDir + '" && mkdir -p "' + tmpDir + '"; ' +
                            '/usr/bin/unzip -o -q "' + uploadZip + '" -d "' + tmpDir + '/"; ' +
                            'FOUND=0; ' +
                            'for f in dvbs sat ipsrv dvbt dvbc; do ' +
                            '  if [ -f "' + tmpDir + '/$f" ]; then FOUND=1; break; fi; ' +
                            'done; ' +
                            'if [ $FOUND -eq 0 ]; then ' +
                            '  rm -rf "' + tmpDir + '" "' + uploadZip + '"; echo "NO_CHANNELS_FOUND"; exit 2; ' +
                            'fi; ' +
                            'for f in dvbs sat ipsrv dvbt dvbc; do ' +
                            '  if [ -f "' + tmpDir + '/$f" ]; then ' +
                            '    CHK=$(sqlite3 "' + tmpDir + '/$f" "PRAGMA integrity_check;" 2>/dev/null || echo "corrupt"); ' +
                            '    if [ "$CHK" != "ok" ]; then ' +
                            '      rm -rf "' + tmpDir + '" "' + uploadZip + '"; echo "CORRUPT_DB_$f"; exit 3; ' +
                            '    fi; ' +
                            '  fi; ' +
                            'done; ' +
                            'rm -rf "' + bakDir + '" && mkdir -p "' + bakDir + '"; ' +
                            'cp /mnt/systemrw/tvs-chms/data/* "' + bakDir + '/" 2>/dev/null || true; ' +
                            'rm -f /mnt/systemrw/tvs-chms/data/*-wal /mnt/systemrw/tvs-chms/data/*-shm; ' +
                            'for f in dvbs sat ipsrv dvbt dvbc metadata.xml; do ' +
                            '  if [ -f "' + tmpDir + '/$f" ]; then ' +
                            '    cp "' + tmpDir + '/$f" "/mnt/systemrw/tvs-chms/data/$f"; ' +
                            '  fi; ' +
                            'done; ' +
                            '[ -f /mnt/systemrw/tvs-chms/data/dvbs ] && sqlite3 /mnt/systemrw/tvs-chms/data/dvbs "PRAGMA wal_checkpoint(TRUNCATE);" 2>/dev/null || true; ' +
                            '[ -f /mnt/systemrw/tvs-chms/data/ipsrv ] && sqlite3 /mnt/systemrw/tvs-chms/data/ipsrv "PRAGMA wal_checkpoint(TRUNCATE);" 2>/dev/null || true; ' +
                            '(systemctl restart tvs_deamon.service || pkill -9 tvs-daemon || true); sleep 1; ' +
                            '(/usr/bin/launch_app org.tizen.tv-viewer change_source 0 sourceType 0 sourceName TV mbrIndex -2 __K_EX_LAUNCH_REQUESTOR user >/dev/null 2>&1 || true); ' +
                            'rm -rf "' + tmpDir + '" "' + bakDir + '" "' + uploadZip + '"; ' +
                            'echo "SUCCESS"\';';

                        ctx.execute(importCmd, 20000).then(function (r) {
                            release();
                            cachedChannels = null;
                            var out = (r.stdout || '').trim();
                            if (out.indexOf('INVALID_ZIP') >= 0) {
                                res.writeHead(400, { 'content-type': 'application/json' });
                                res.end(JSON.stringify({ ok: false, error: 'The uploaded file is not a valid zip archive.' }));
                                return;
                            }
                            if (out.indexOf('NO_CHANNELS_FOUND') >= 0) {
                                res.writeHead(400, { 'content-type': 'application/json' });
                                res.end(JSON.stringify({ ok: false, error: 'No channel databases (dvbs, ipsrv, dvbt) found inside archive.' }));
                                return;
                            }
                            if (out.indexOf('CORRUPT_DB_') >= 0) {
                                res.writeHead(400, { 'content-type': 'application/json' });
                                res.end(JSON.stringify({ ok: false, error: 'Database integrity check failed: corrupt SQLite database in zip.' }));
                                return;
                            }
                            if (r.exit_code !== 0) {
                                // Restore backup on error
                                ctx.execute('sh -c "if [ -d \\"' + bakDir + '\\" ]; then cp \\"' + bakDir + '\\"/* /mnt/systemrw/tvs-chms/data/ 2>/dev/null || true; fi; rm -rf \\"' + tmpDir + '\\" \\"' + bakDir + '\\" \\"' + uploadZip + '\\";"', 10000);
                                res.writeHead(500, { 'content-type': 'application/json' });
                                res.end(JSON.stringify({ ok: false, error: 'Import failed: ' + (r.stderr || 'exit code ' + r.exit_code) }));
                                return;
                            }
                            res.writeHead(200, { 'content-type': 'application/json' });
                            res.end(JSON.stringify({ ok: true, message: 'Channels imported successfully and TV tuner reloaded!' }));
                        }, function (e) {
                            ctx.execute('sh -c "if [ -d \\"' + bakDir + '\\" ]; then cp \\"' + bakDir + '\\"/* /mnt/systemrw/tvs-chms/data/ 2>/dev/null || true; fi; rm -rf \\"' + tmpDir + '\\" \\"' + bakDir + '\\" \\"' + uploadZip + '\\";"', 10000);
                            release();
                            res.writeHead(500, { 'content-type': 'application/json' });
                            res.end(JSON.stringify({ ok: false, error: e.message }));
                        });
                    });

                    outStream.on('error', function (err) {
                        try { fs.unlinkSync(uploadZip); } catch (e) {}
                        release();
                        res.writeHead(500, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: err.message }));
                    });
                });
                return true;
            }

            return false;
        }
    };
};
