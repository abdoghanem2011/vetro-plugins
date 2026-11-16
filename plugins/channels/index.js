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

function computeChannelMoves(allChannels, selectedNums, target) {
    var selectedSet = {};
    for (var i = 0; i < selectedNums.length; i++) {
        selectedSet[selectedNums[i]] = true;
    }

    var selected = [];
    var unselected = [];
    for (var j = 0; j < allChannels.length; j++) {
        var ch = allChannels[j];
        if (selectedSet[ch.major]) {
            selected.push(ch);
        } else {
            unselected.push(ch);
        }
    }

    selected.sort(function (a, b) { return a.major - b.major; });
    unselected.sort(function (a, b) { return a.major - b.major; });
    var k = selected.length;

    if (k === 0) return { error: 'No channels selected' };
    if (isNaN(target) || target < 1 || target > 9999) return { error: 'Target channel number must be between 1 and 9999' };
    if (target + k - 1 > 9999) return { error: 'Target range would exceed maximum channel number 9999' };

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
        return { error: 'Selected channel(s) already occupy #' + target + (k > 1 ? (' - #' + (target + k - 1)) : '') };
    }

    var allSorted = allChannels.slice().sort(function (a, b) { return a.major - b.major; });
    var maxOrig = allSorted.length > 0 ? allSorted[allSorted.length - 1].major : 0;

    // If moving beyond the max existing channel number into open space:
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

    var involved = [];
    var involvedUnselected = [];
    var occupiedSlotsMap = {};

    for (var q = 0; q < allSorted.length; q++) {
        var cItem = allSorted[q];
        if (cItem.major >= minInvolved && cItem.major <= maxInvolved) {
            involved.push(cItem);
            occupiedSlotsMap[cItem.major] = true;
            if (!selectedSet[cItem.major]) {
                involvedUnselected.push(cItem);
            }
        }
    }

    for (var tIdx = 0; tIdx < targetSlots.length; tIdx++) {
        occupiedSlotsMap[targetSlots[tIdx]] = true;
    }

    var occupiedSlots = [];
    for (var slotStr in occupiedSlotsMap) {
        if (occupiedSlotsMap.hasOwnProperty(slotStr)) {
            occupiedSlots.push(parseInt(slotStr, 10));
        }
    }
    occupiedSlots.sort(function (a, b) { return a - b; });

    var targetSlotsSet = {};
    for (var ts = 0; ts < targetSlots.length; ts++) {
        targetSlotsSet[targetSlots[ts]] = true;
    }

    var unselectedSlots = [];
    for (var os = 0; os < occupiedSlots.length; os++) {
        if (!targetSlotsSet[occupiedSlots[os]]) {
            unselectedSlots.push(occupiedSlots[os]);
        }
    }

    var newAssignments = {};
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
        if (newAssignments.hasOwnProperty(curCh.srvId) && newAssignments[curCh.srvId] !== curCh.major) {
            changes.push({
                srvId: curCh.srvId,
                oldMajor: curCh.major,
                newMajor: newAssignments[curCh.srvId]
            });
        }
    }

    return { changes: changes };
}

function deleteAndCompactDb(ctx, dbPath, delSet) {
    return new Promise(function (resolve, reject) {
        ctx.execute('sqlite3 ' + dbPath + ' "SELECT srvId, major FROM SRV WHERE elim = 0 ORDER BY major ASC;"', 10000)
            .then(function (qRes) {
                if (qRes.exit_code !== 0) {
                    return reject(new Error('Failed to query channels from ' + dbPath + ': ' + qRes.stderr));
                }

                var lines = (qRes.stdout || '').split('\n');
                var dbChannels = [];
                for (var i = 0; i < lines.length; i++) {
                    var line = lines[i].trim();
                    if (!line) continue;
                    var parts = line.split('|');
                    if (parts.length >= 2) {
                        var m = parseInt(parts[1], 10);
                        if (!isNaN(m)) {
                            dbChannels.push({
                                srvId: parts[0],
                                major: m
                            });
                        }
                    }
                }

                if (dbChannels.length === 0) {
                    return resolve({ deleted: 0, shifted: 0, remaining: 0 });
                }

                var toDelete = [];
                var toKeep = [];
                for (var j = 0; j < dbChannels.length; j++) {
                    var ch = dbChannels[j];
                    if (delSet[ch.major]) {
                        toDelete.push(ch);
                    } else {
                        toKeep.push(ch);
                    }
                }

                if (toDelete.length === 0) {
                    return resolve({ deleted: 0, shifted: 0, remaining: dbChannels.length });
                }

                var changes = [];
                for (var k = 0; k < toKeep.length; k++) {
                    var newMajor = k + 1;
                    if (toKeep[k].major !== newMajor) {
                        changes.push({
                            srvId: toKeep[k].srvId,
                            oldMajor: toKeep[k].major,
                            newMajor: newMajor
                        });
                    }
                }

                var delSrvIds = [];
                for (var d = 0; d < toDelete.length; d++) {
                    delSrvIds.push(toDelete[d].srvId);
                }

                var sqlParts = ['BEGIN TRANSACTION;'];
                sqlParts.push('UPDATE SRV SET elim = 1, hidden = 1, hideGuide = 1, numSel = 0, major = 0 WHERE srvId IN (' + delSrvIds.join(',') + ');');

                if (changes.length > 0) {
                    var caseClauses = [];
                    var changeSrvIds = [];
                    for (var c = 0; c < changes.length; c++) {
                        caseClauses.push('WHEN ' + changes[c].srvId + ' THEN ' + changes[c].newMajor);
                        changeSrvIds.push(changes[c].srvId);
                    }
                    sqlParts.push('UPDATE SRV SET major = CASE srvId ' + caseClauses.join(' ') + ' END, modifiedByUser = 1 WHERE srvId IN (' + changeSrvIds.join(',') + ');');
                }

                sqlParts.push('COMMIT;');
                sqlParts.push('PRAGMA wal_checkpoint(TRUNCATE);');

                var fullSql = sqlParts.join('\n');
                var tmpFile = '/tmp/ch_del_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6) + '.sql';

                try {
                    fs.writeFileSync(tmpFile, fullSql, 'utf8');
                } catch (fsErr) {
                    return reject(new Error('Failed to write temp SQL file: ' + fsErr.message));
                }

                var cmd = 'sqlite3 ' + dbPath + ' < ' + tmpFile + '; rm -f ' + tmpFile + ';';
                ctx.execute(cmd, 15000)
                    .then(function (res) {
                        if (res.exit_code !== 0) {
                            return reject(new Error('Failed to execute delete & compact on ' + dbPath + ': ' + res.stderr));
                        }
                        resolve({
                            deleted: toDelete.length,
                            shifted: changes.length,
                            remaining: toKeep.length
                        });
                    })
                    .catch(function (execErr) {
                        try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore */ }
                        reject(execErr);
                    });
            })
            .catch(reject);
    });
}

function deleteAndCompactChannels(ctx, channelsToDelete) {
    var delSet = {};
    for (var i = 0; i < channelsToDelete.length; i++) {
        delSet[channelsToDelete[i]] = true;
    }

    return deleteAndCompactDb(ctx, '/mnt/systemrw/tvs-chms/data/dvbs', delSet)
        .then(function (dvbsRes) {
            return deleteAndCompactDb(ctx, '/mnt/systemrw/tvs-chms/data/ipsrv', delSet)
                .then(function (ipsrvRes) {
                    return {
                        deleted: dvbsRes.deleted + ipsrvRes.deleted,
                        shifted: dvbsRes.shifted + ipsrvRes.shifted,
                        remaining: dvbsRes.remaining + ipsrvRes.remaining
                    };
                })
                .catch(function () {
                    return dvbsRes;
                });
        });
}

function loadPage(ctx) {
    var places = [path.join(__dirname, 'ui.html'), path.join(ctx.dir || '', 'ui.html')];
    for (var i = 0; i < places.length; i++) {
        try { return fs.readFileSync(places[i], 'utf8'); } catch (e) { /* next */ }
    }
    return '<!doctype html><meta charset="utf-8"><p>Page file missing: reinstall this Shard.</p>';
}

module.exports = function (ctx) {
    var page = null;
    var cachedChannels = null;
    var lastFetchTime = 0;

    function queryDatabase() {
        var sql = "ATTACH '/mnt/systemrw/tvs-chms/data/sat' AS sat_db; " +
            "SELECT S.major, S.srvName, IFNULL(T.tpFreq/1000, 0), IFNULL(T.tpPol, -1), IFNULL(T.tpSr, 0), IFNULL(SAT.satName, ''), S.scrambled, S.hidden, S.srvId " +
            "FROM SRV S " +
            "LEFT JOIN CHNL C ON S.chId = C.chId " +
            "LEFT JOIN sat_db.SAT_TP T ON C.chNum = T.tpId " +
            "LEFT JOIN sat_db.SAT SAT ON T.satId = SAT.satId " +
            "WHERE S.elim = 0 " +
            "ORDER BY S.major ASC;";

        var cmd = 'sqlite3 /mnt/systemrw/tvs-chms/data/dvbs "' + sql + '"';

        return ctx.execute(cmd, 10000).then(function (res) {
            var channels = [];
            if (res.exit_code === 0 && res.stdout) {
                var lines = res.stdout.split('\n');
                for (var i = 0; i < lines.length; i++) {
                    var line = lines[i];
                    if (!line) continue;
                    var parts = line.split('|');
                    if (parts.length < 8) continue;
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

                    channels.push({
                        num: major,
                        name: name,
                        freq: freq,
                        pol: pol,
                        sr: sr,
                        sat: sat || 'Satellite',
                        type: 'dvbs',
                        scrambled: scrambled,
                        hidden: hidden,
                        srvId: srvId
                    });
                }
            }

            // Also query IPTV (Samsung TV Plus) from ipsrv
            var sqlIp = "SELECT major, srvName, hidden, srvId FROM SRV WHERE elim = 0 ORDER BY major ASC;";
            var cmdIp = 'sqlite3 /mnt/systemrw/tvs-chms/data/ipsrv "' + sqlIp + '"';

            return ctx.execute(cmdIp, 5000).then(function (resIp) {
                if (resIp.exit_code === 0 && resIp.stdout) {
                    var linesIp = resIp.stdout.split('\n');
                    for (var j = 0; j < linesIp.length; j++) {
                        var l = linesIp[j];
                        if (!l) continue;
                        var p = l.split('|');
                        if (p.length < 3) continue;
                        var m = parseInt(p[0], 10);
                        if (isNaN(m)) continue;
                        var ipSrvId = p[3] ? String(p[3]).trim() : '';
                        channels.push({
                            num: m,
                            name: decodeUtf16(p[1]),
                            freq: 0,
                            pol: '',
                            sr: 0,
                            sat: 'Samsung TV Plus',
                            type: 'iptv',
                            scrambled: false,
                            hidden: p[2] === '1',
                            srvId: ipSrvId
                        });
                    }
                }

                cachedChannels = channels;
                lastFetchTime = Date.now();
                return channels;
            }).catch(function () {
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
        },

        status: function () {
            return {
                ok: true,
                count: cachedChannels ? cachedChannels.length : 0
            };
        },

        route: function (req, res, sub) {
            var action = (sub || '').split('?')[0];

            // Global CORS OPTIONS preflight handler for sandboxed iframe UI
            if (req.method === 'OPTIONS') {
                res.writeHead(204, {
                    'access-control-allow-origin': '*',
                    'access-control-allow-methods': 'GET, POST, OPTIONS',
                    'access-control-allow-headers': '*',
                    'access-control-max-age': '86400'
                });
                res.end();
                return true;
            }

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
                    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
                    res.end(JSON.stringify({ ok: true, channels: cachedChannels }));
                    return true;
                }

                queryDatabase()
                    .then(function (channels) {
                        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
                        res.end(JSON.stringify({ ok: true, channels: channels }));
                    })
                    .catch(function (err) {
                        res.writeHead(500, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: err.message }));
                    });
                return true;
            }

            // POST api/tune — switch TV to selected channel number or direct srvId
            if ((sub === 'tune' || action === 'tune') && req.method === 'POST') {
                var body = '';
                req.on('data', function (c) { body += c; });
                req.on('end', function () {
                    var parsed, channel, srvId, forceTv;
                    try {
                        parsed = JSON.parse(body);
                        channel = parseInt(parsed.channel, 10);
                        srvId = parsed.srvId ? String(parsed.srvId).trim() : null;
                        forceTv = !!parsed.forceTv;
                    } catch (e) {
                        channel = null;
                        srvId = null;
                        forceTv = false;
                    }

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
                    if (srvId && /^-?[0-9]+$/.test(srvId)) {
                        var launchCmd = '/usr/bin/launch_app org.tizen.tv-viewer tune_channel ' + srvId;
                        ctx.execute(launchCmd, 4000)
                            .then(function (r) {
                                res.writeHead(200, { 'content-type': 'application/json' });
                                res.end(JSON.stringify({ ok: r.exit_code === 0, channel: channel, srvId: srvId, method: 'direct' }));
                            })
                            .catch(function (e) {
                                res.writeHead(500, { 'content-type': 'application/json' });
                                res.end(JSON.stringify({ ok: false, error: e.message }));
                            });
                        return;
                    }

                    // METHOD 2 (Fallback): High-Speed Async D-Bus Key Injection
                    if (!channel || isNaN(channel) || channel <= 0) {
                        res.writeHead(400, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: 'invalid channel number or srvId' }));
                        return;
                    }

                    var digits = String(channel).split('');
                    var keyCmds = [];

                    if (forceTv) {
                        keyCmds.push('dbus-send --system --type=method_call --dest=org.enlightenment.wm /org/enlightenment/wm org.enlightenment.wm.Test.EventKey uint32:1 string:XF86TV; dbus-send --system --type=method_call --dest=org.enlightenment.wm /org/enlightenment/wm org.enlightenment.wm.Test.EventKey uint32:0 string:XF86TV');
                        keyCmds.push('sleep 0.5');
                    }

                    for (var d = 0; d < digits.length; d++) {
                        keyCmds.push('dbus-send --system --type=method_call --dest=org.enlightenment.wm /org/enlightenment/wm org.enlightenment.wm.Test.EventKey uint32:1 string:"' + digits[d] + '"; dbus-send --system --type=method_call --dest=org.enlightenment.wm /org/enlightenment/wm org.enlightenment.wm.Test.EventKey uint32:0 string:"' + digits[d] + '"');
                        if (d < digits.length - 1) {
                            keyCmds.push('sleep 0.05');
                        }
                    }
                    keyCmds.push('sleep 0.05');
                    keyCmds.push('dbus-send --system --type=method_call --dest=org.enlightenment.wm /org/enlightenment/wm org.enlightenment.wm.Test.EventKey uint32:1 string:Return; dbus-send --system --type=method_call --dest=org.enlightenment.wm /org/enlightenment/wm org.enlightenment.wm.Test.EventKey uint32:0 string:Return');

                    var fullCmd = keyCmds.join('; ');

                    ctx.execute(fullCmd, 6000)
                        .then(function (r) {
                            res.writeHead(200, { 'content-type': 'application/json' });
                            res.end(JSON.stringify({ ok: r.exit_code === 0, channel: channel, method: 'keys', stderr: r.stderr }));
                        })
                        .catch(function (e) {
                            res.writeHead(500, { 'content-type': 'application/json' });
                            res.end(JSON.stringify({ ok: false, error: e.message }));
                        });
                });
                return true;
            }

            // POST api/tvsource — switch input directly to Broadcast TV
            if ((sub === 'tvsource' || action === 'tvsource') && req.method === 'POST') {
                var switchCmd = 'sh -c "/usr/bin/input_keyevent XF86Exit; /usr/bin/launch_app org.tizen.tv-viewer change_source 0 sourceType 0 sourceName TV mbrIndex -2 __K_EX_LAUNCH_REQUESTOR user"';
                ctx.execute(switchCmd, 6000)
                    .then(function (r) {
                        res.writeHead(200, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: r.exit_code === 0 }));
                    })
                    .catch(function (e) {
                        res.writeHead(500, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: e.message }));
                    });
                return true;
            }

            // POST api/reload — reload channel manager daemon without rebooting TV
            if ((sub === 'reload' || action === 'reload') && req.method === 'POST') {
                ctx.execute('pkill -9 tvs-daemon; sleep 0.5', 6000)
                    .then(function (r) {
                        cachedChannels = null;
                        res.writeHead(200, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: r.exit_code === 0 }));
                    })
                    .catch(function (e) {
                        res.writeHead(500, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: e.message }));
                    });
                return true;
            }

            // POST api/key — send key event (e.g. Vol+, Vol-, CH+, CH-)
            if ((sub === 'key' || action === 'key') && req.method === 'POST') {
                var bKey = '';
                req.on('data', function (c) { bKey += c; });
                req.on('end', function () {
                    var p, k;
                    try {
                        p = JSON.parse(bKey);
                        k = p.key;
                    } catch (e) {
                        k = null;
                    }
                    var keySym = null;
                    if (k === 'vol_up' || k === 'vol+' || k === 'VolumeUp') {
                        keySym = 'XF86AudioRaiseVolume';
                    } else if (k === 'vol_down' || k === 'vol-' || k === 'VolumeDown') {
                        keySym = 'XF86AudioLowerVolume';
                    } else if (k === 'ch_up' || k === 'ch+' || k === 'ChannelUp') {
                        keySym = 'XF86RaiseChannel';
                    } else if (k === 'ch_down' || k === 'ch-' || k === 'ChannelDown') {
                        keySym = 'XF86LowerChannel';
                    } else if (typeof k === 'string' && /^[A-Za-z0-9_-]+$/.test(k)) {
                        keySym = k;
                    }

                    if (!keySym) {
                        res.writeHead(400, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: 'Invalid key' }));
                        return;
                    }

                    ctx.execute('/usr/bin/input_keyevent ' + keySym, 3000)
                        .then(function (r) {
                            res.writeHead(200, { 'content-type': 'application/json' });
                            res.end(JSON.stringify({ ok: r.exit_code === 0, key: keySym }));
                        })
                        .catch(function (e) {
                            res.writeHead(500, { 'content-type': 'application/json' });
                            res.end(JSON.stringify({ ok: false, error: e.message }));
                        });
                });
                return true;
            }

            // POST api/edit — manage channel flags (hide, unhide, delete, restore) for single or multiple channels
            if ((sub === 'edit' || action === 'edit') && req.method === 'POST') {
                var bEdit = '';
                req.on('data', function (c) { bEdit += c; });
                req.on('end', function () {
                    var parsed, action, channels;
                    try {
                        parsed = JSON.parse(bEdit);
                        action = parsed.action;
                        channels = [];
                        if (Array.isArray(parsed.channels)) {
                            for (var ci = 0; ci < parsed.channels.length; ci++) {
                                var cNum = parseInt(parsed.channels[ci], 10);
                                if (cNum > 0 && !isNaN(cNum)) channels.push(cNum);
                            }
                        } else if (parsed.channel) {
                            var sNum = parseInt(parsed.channel, 10);
                            if (sNum > 0 && !isNaN(sNum)) channels.push(sNum);
                        }
                    } catch (e) {
                        action = null;
                        channels = [];
                    }

                    if (!action || channels.length === 0) {
                        res.writeHead(400, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: 'missing action or channels' }));
                        return;
                    }

                    var chListStr = channels.join(',');
                    var sql = '';
                    if (action === 'hide') {
                        sql = 'UPDATE SRV SET hidden = 1, hideGuide = 1, numSel = 0 WHERE major IN (' + chListStr + ');';
                    } else if (action === 'unhide') {
                        sql = 'UPDATE SRV SET hidden = 0, hideGuide = 0, numSel = 1 WHERE major IN (' + chListStr + ');';
                    } else if (action === 'delete') {
                        deleteAndCompactChannels(ctx, channels)
                            .then(function (result) {
                                cachedChannels = null;
                                res.writeHead(200, { 'content-type': 'application/json' });
                                res.end(JSON.stringify({
                                    ok: true,
                                    action: 'delete',
                                    deleted: result.deleted,
                                    shifted: result.shifted,
                                    remaining: result.remaining
                                }));
                            })
                            .catch(function (delErr) {
                                res.writeHead(500, { 'content-type': 'application/json' });
                                res.end(JSON.stringify({ ok: false, error: delErr.message }));
                            });
                        return;
                    } else if (action === 'restore') {
                        sql = 'UPDATE SRV SET elim = 0, hidden = 0, hideGuide = 0, numSel = 1 WHERE major IN (' + chListStr + ');';
                    } else if (action === 'rename') {
                        var newName = (parsed.name || '').trim();
                        if (!newName) {
                            res.writeHead(400, { 'content-type': 'application/json' });
                            res.end(JSON.stringify({ ok: false, error: 'missing channel name' }));
                            return;
                        }
                        var hexName = encodeUtf16Hex(newName);
                        if (parsed.srvId && /^-?[0-9]+$/.test(String(parsed.srvId).trim())) {
                            sql = "UPDATE SRV SET srvName = CAST(X'" + hexName + "' AS TEXT), modifiedByUser = 1 WHERE srvId = " + parsed.srvId + ";";
                        } else {
                            sql = "UPDATE SRV SET srvName = CAST(X'" + hexName + "' AS TEXT), modifiedByUser = 1 WHERE major = " + channels[0] + ";";
                        }
                    } else if (action === 'move') {
                        var target = parseInt(parsed.target, 10);
                        if (isNaN(target) || target < 1 || target > 9999) {
                            res.writeHead(400, { 'content-type': 'application/json' });
                            res.end(JSON.stringify({ ok: false, error: 'target channel must be between 1 and 9999' }));
                            return;
                        }

                        var targetType = parsed.type === 'ipsrv' ? 'ipsrv' : 'dvbs';
                        var dbPath = targetType === 'ipsrv' ? '/mnt/systemrw/tvs-chms/data/ipsrv' : '/mnt/systemrw/tvs-chms/data/dvbs';

                        ctx.execute('sqlite3 ' + dbPath + ' "SELECT srvId, major FROM SRV ORDER BY major ASC;"', 10000)
                            .then(function (qRes) {
                                if (qRes.exit_code !== 0) {
                                    res.writeHead(500, { 'content-type': 'application/json' });
                                    res.end(JSON.stringify({ ok: false, error: 'database query failed: ' + qRes.stderr }));
                                    return;
                                }

                                var lines = (qRes.stdout || '').split('\n');
                                var dbChannels = [];
                                for (var i = 0; i < lines.length; i++) {
                                    var line = lines[i].trim();
                                    if (!line) continue;
                                    var parts = line.split('|');
                                    if (parts.length >= 2) {
                                        dbChannels.push({
                                            srvId: parts[0],
                                            major: parseInt(parts[1], 10)
                                        });
                                    }
                                }

                                var plan = computeChannelMoves(dbChannels, channels, target);
                                if (plan.error) {
                                    res.writeHead(400, { 'content-type': 'application/json' });
                                    res.end(JSON.stringify({ ok: false, error: plan.error }));
                                    return;
                                }

                                var changes = plan.changes || [];
                                if (changes.length === 0) {
                                    res.writeHead(200, { 'content-type': 'application/json' });
                                    res.end(JSON.stringify({ ok: true, action: 'move', changed: 0, message: 'Channels are already at the target location' }));
                                    return;
                                }

                                var caseParts = [];
                                var srvIdList = [];
                                for (var c = 0; c < changes.length; c++) {
                                    caseParts.push('WHEN ' + changes[c].srvId + ' THEN ' + changes[c].newMajor);
                                    srvIdList.push(changes[c].srvId);
                                }

                                var moveSql = 'UPDATE SRV SET major = CASE srvId ' + caseParts.join(' ') + ' END, modifiedByUser = 1 WHERE srvId IN (' + srvIdList.join(',') + '); PRAGMA wal_checkpoint(TRUNCATE);';

                                ctx.execute('sqlite3 ' + dbPath + ' "' + moveSql + '"', 15000)
                                    .then(function (upRes) {
                                        cachedChannels = null;
                                        res.writeHead(200, { 'content-type': 'application/json' });
                                        res.end(JSON.stringify({
                                            ok: upRes.exit_code === 0,
                                            action: 'move',
                                            target: target,
                                            moved: channels.length,
                                            changed: changes.length,
                                            changes: changes,
                                            exit_code: upRes.exit_code,
                                            stderr: upRes.stderr
                                        }));
                                    })
                                    .catch(function (upErr) {
                                        res.writeHead(500, { 'content-type': 'application/json' });
                                        res.end(JSON.stringify({ ok: false, error: upErr.message }));
                                    });
                            })
                            .catch(function (qErr) {
                                res.writeHead(500, { 'content-type': 'application/json' });
                                res.end(JSON.stringify({ ok: false, error: qErr.message }));
                            });
                        return;
                    } else {
                        res.writeHead(400, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: 'unsupported action' }));
                        return;
                    }

                    // Update channel flags in SQLite and checkpoint to disk without restarting daemon so playback is not interrupted
                    var editCmd = 'sqlite3 /mnt/systemrw/tvs-chms/data/dvbs "' + sql + ' PRAGMA wal_checkpoint(TRUNCATE);"; ' +
                        'sqlite3 /mnt/systemrw/tvs-chms/data/ipsrv "' + sql + ' PRAGMA wal_checkpoint(TRUNCATE);"';

                    ctx.execute(editCmd, 10000)
                        .then(function (r) {
                            cachedChannels = null; // Invalidate cache
                            res.writeHead(200, { 'content-type': 'application/json' });
                            res.end(JSON.stringify({ ok: r.exit_code === 0, action: action, count: channels.length, channels: channels, exit_code: r.exit_code, stderr: r.stderr, stdout: r.stdout }));
                        })
                        .catch(function (e) {
                            res.writeHead(500, { 'content-type': 'application/json' });
                            res.end(JSON.stringify({ ok: false, error: e.message }));
                        });
                });
                return true;
            }

            // GET api/satellites — list satellites & next available channel number
            if ((sub === 'satellites' || action === 'satellites') && req.method === 'GET') {
                var satSql = "ATTACH '/mnt/systemrw/tvs-chms/data/dvbs' AS dvbs_db; " +
                    "SELECT S.satId, S.satName, count(C.chId) as cnt " +
                    "FROM SAT S " +
                    "LEFT JOIN SAT_TP T ON S.satId = T.satId " +
                    "LEFT JOIN dvbs_db.CHNL C ON T.tpId = C.chNum " +
                    "GROUP BY S.satId " +
                    "HAVING cnt > 0 OR S.satId IN (1, 5, 23, 35) " +
                    "ORDER BY cnt DESC, S.satId ASC; " +
                    "SELECT IFNULL(MAX(major), 0) + 1 FROM dvbs_db.SRV;";

                var satCmd = 'sqlite3 /mnt/systemrw/tvs-chms/data/sat "' + satSql + '"';

                ctx.execute(satCmd, 6000).then(function (r) {
                    var lines = (r.stdout || '').trim().split('\n');
                    var sats = [];
                    var defaultSatId = 35; // Default Nilesat
                    var nextMajor = 1500;

                    for (var i = 0; i < lines.length; i++) {
                        var line = lines[i].trim();
                        if (!line) continue;
                        var parts = line.split('|');
                        if (parts.length >= 3) {
                            var sid = parseInt(parts[0], 10);
                            var sname = decodeUtf16(parts[1]);
                            var cnt = parseInt(parts[2], 10) || 0;
                            if (sats.length === 0 && cnt > 0) defaultSatId = sid;
                            sats.push({ id: sid, name: sname || ('Satellite ' + sid), count: cnt });
                        } else if (parts.length === 1 && !isNaN(parseInt(parts[0], 10))) {
                            nextMajor = parseInt(parts[0], 10);
                        }
                    }

                    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
                    res.end(JSON.stringify({ ok: true, satellites: sats, defaultSatId: defaultSatId, nextMajor: nextMajor }));
                }).catch(function (e) {
                    res.writeHead(500, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
                    res.end(JSON.stringify({ ok: false, error: e.message }));
                });
                return true;
            }

            // GET api/tp_channels?freq=12054&pol=V&satId=35 — lookup existing channels on transponder
            if ((sub === 'tp_channels' || action === 'tp_channels') && req.method === 'GET') {
                var urlParts = req.url.split('?');
                var qs = urlParts.length > 1 ? urlParts[1] : '';
                var params = {};
                var pairs = qs.split('&');
                for (var pi = 0; pi < pairs.length; pi++) {
                    var kv = pairs[pi].split('=');
                    if (kv.length === 2) params[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1]);
                }

                var qFreq = parseInt(params.freq, 10) || 0;
                var qPol = (params.pol || 'H').toUpperCase() === 'V' ? 'V' : 'H';
                var qPolNum = qPol === 'H' ? 0 : 1;
                var qSatId = parseInt(params.satId, 10) || 35;

                if (!qFreq || qFreq < 1000) {
                    res.writeHead(400, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
                    res.end(JSON.stringify({ ok: false, error: 'Valid freq parameter required' }));
                    return true;
                }

                var qFreqKhz = qFreq > 100000 ? qFreq : (qFreq * 1000);

                var tpSql = "ATTACH '/mnt/systemrw/tvs-chms/data/sat' AS sat_db; " +
                    "SELECT S.major, S.srvName, S.progNum, S.vidPid, S.pcr, T.tpSr, T.tpFec " +
                    "FROM sat_db.SAT_TP T " +
                    "JOIN CHNL C ON C.chNum = T.tpId " +
                    "JOIN SRV S ON S.chId = C.chId " +
                    "WHERE T.satId = " + qSatId + " AND T.tpFreq = " + qFreqKhz + " AND T.tpPol = " + qPolNum + " AND S.elim = 0 " +
                    "ORDER BY S.major ASC; " +
                    "SELECT tpSr, tpFec FROM sat_db.SAT_TP WHERE satId = " + qSatId + " AND tpFreq = " + qFreqKhz + " AND tpPol = " + qPolNum + " LIMIT 1;";

                var tpCmd = 'sqlite3 /mnt/systemrw/tvs-chms/data/dvbs "' + tpSql + '"';

                ctx.execute(tpCmd, 6000).then(function (r) {
                    var lines = (r.stdout || '').trim().split('\n');
                    var channels = [];
                    var tpSr = 27500;
                    var tpFec = 0;

                    for (var i = 0; i < lines.length; i++) {
                        var line = lines[i].trim();
                        if (!line) continue;
                        var parts = line.split('|');
                        if (parts.length >= 7) {
                            var major = parseInt(parts[0], 10);
                            var name = decodeUtf16(parts[1]);
                            var sid = parseInt(parts[2], 10);
                            var vpid = parseInt(parts[3], 10);
                            var pcr = parseInt(parts[4], 10);
                            tpSr = parseInt(parts[5], 10) || tpSr;
                            tpFec = parseInt(parts[6], 10) || tpFec;
                            channels.push({ major: major, name: name, sid: sid, vpid: vpid, pcr: pcr });
                        } else if (parts.length >= 2 && channels.length === 0) {
                            tpSr = parseInt(parts[0], 10) || tpSr;
                            tpFec = parseInt(parts[1], 10) || tpFec;
                        }
                    }

                    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
                    res.end(JSON.stringify({
                        ok: true,
                        found: channels.length > 0,
                        tpSr: tpSr,
                        tpFec: tpFec,
                        channels: channels
                    }));
                }).catch(function (e) {
                    res.writeHead(500, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
                    res.end(JSON.stringify({ ok: false, error: e.message }));
                });
                return true;
            }

            // POST api/add_channel — manually add satellite channel
            if ((sub === 'add_channel' || action === 'add_channel') && req.method === 'POST') {
                var bAdd = '';
                req.on('data', function (c) { bAdd += c; });
                req.on('end', function () {
                    var p;
                    try { p = JSON.parse(bAdd); } catch (e) { p = {}; }

                    var name = (p.name || '').trim();
                    var freqMhz = parseInt(p.freq, 10);
                    var pol = (p.pol || 'H').toUpperCase() === 'V' ? 'V' : 'H';
                    var polNum = pol === 'H' ? 0 : 1;
                    var sr = parseInt(p.sr, 10) || 27500;
                    var satId = parseInt(p.satId, 10) || 35;
                    var major = parseInt(p.major, 10) || 0;
                    var progNum = parseInt(p.progNum, 10) || 0;
                    var vidPid = parseInt(p.vidPid, 10) || 0;
                    var fec = parseInt(p.fec, 10) || 0;

                    if (!name) {
                        res.writeHead(400, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
                        res.end(JSON.stringify({ ok: false, error: 'Channel name is required.' }));
                        return;
                    }
                    if (!freqMhz || isNaN(freqMhz) || freqMhz < 1000) {
                        res.writeHead(400, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
                        res.end(JSON.stringify({ ok: false, error: 'Valid frequency in MHz (e.g. 11411) is required.' }));
                        return;
                    }
                    if (!progNum || isNaN(progNum) || progNum <= 0) {
                        res.writeHead(400, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
                        res.end(JSON.stringify({ ok: false, error: 'Service ID (SID) is required so the TV tuner can decode this channel.' }));
                        return;
                    }
                    if (!vidPid || isNaN(vidPid) || vidPid <= 0) {
                        res.writeHead(400, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
                        res.end(JSON.stringify({ ok: false, error: 'Video PID is required so the TV tuner can decode the video stream.' }));
                        return;
                    }

                    var pcr = parseInt(p.pcr, 10) || vidPid;
                    var freqKhz = freqMhz > 100000 ? freqMhz : (freqMhz * 1000);
                    var hexName = encodeUtf16Hex(name);

                    var addCmd = 'SAT_ID=' + satId + '; FREQ_KHZ=' + freqKhz + '; POL_NUM=' + polNum + '; SR=' + sr + '; FEC=' + fec + '; PROG_NUM=' + progNum + '; VID_PID=' + vidPid + '; PCR=' + pcr + '; MAJOR=' + major + '; ' +
                        'TP_ID=$(sqlite3 /mnt/systemrw/tvs-chms/data/sat "SELECT tpId FROM SAT_TP WHERE satId = $SAT_ID AND tpFreq = $FREQ_KHZ AND tpPol = $POL_NUM LIMIT 1;" 2>/dev/null); ' +
                        'if [ -z "$TP_ID" ]; then ' +
                        '  TP_ID=$(sqlite3 /mnt/systemrw/tvs-chms/data/sat "INSERT INTO SAT_TP (satId, tpFreq, tpPol, tpFec, tpSr, usrTp) VALUES ($SAT_ID, $FREQ_KHZ, $POL_NUM, $FEC, $SR, 1); SELECT last_insert_rowid();"); ' +
                        'else ' +
                        '  sqlite3 /mnt/systemrw/tvs-chms/data/sat "UPDATE SAT_TP SET tpSr = $SR, tpFec = (CASE WHEN $FEC > 0 THEN $FEC ELSE tpFec END) WHERE tpId = $TP_ID;"; ' +
                        'fi; ' +
                        'CH_ID=$(sqlite3 /mnt/systemrw/tvs-chms/data/dvbs "SELECT chId FROM CHNL WHERE chType = 7 AND chNum = $TP_ID LIMIT 1;" 2>/dev/null); ' +
                        'if [ -z "$CH_ID" ]; then ' +
                        '  CH_ID=$(sqlite3 /mnt/systemrw/tvs-chms/data/dvbs "INSERT INTO CHNL (chType, chNum, srvProfile, freq, band, mod, sr, pol, lna, dig, groupId) VALUES (7, $TP_ID, 2, $FREQ_KHZ, 3, 7, 65535, -1, 1, 1, 65535); SELECT last_insert_rowid();"); ' +
                        'fi; ' +
                        'if [ $MAJOR -le 0 ]; then ' +
                        '  MAJOR=$(sqlite3 /mnt/systemrw/tvs-chms/data/dvbs "SELECT IFNULL(MAX(major), 0) + 1 FROM SRV WHERE elim = 0;" 2>/dev/null || echo 1500); ' +
                        'else ' +
                        '  EXISTS=$(sqlite3 /mnt/systemrw/tvs-chms/data/dvbs "SELECT count(*) FROM SRV WHERE elim = 0 AND major = $MAJOR;" 2>/dev/null || echo 0); ' +
                        '  if [ "$EXISTS" -gt 0 ]; then ' +
                        '    sqlite3 /mnt/systemrw/tvs-chms/data/dvbs "UPDATE SRV SET major = -major WHERE elim = 0 AND major >= $MAJOR;"; ' +
                        '    sqlite3 /mnt/systemrw/tvs-chms/data/dvbs "UPDATE SRV SET major = -major + 1, modifiedByUser = 1 WHERE elim = 0 AND major < 0;"; ' +
                        '    sqlite3 /mnt/systemrw/tvs-chms/data/dvbs "UPDATE SRV_DVB SET lcn = -lcn WHERE lcn >= $MAJOR AND lcn < 65535;"; ' +
                        '    sqlite3 /mnt/systemrw/tvs-chms/data/dvbs "UPDATE SRV_DVB SET lcn = -lcn + 1 WHERE lcn < 0;"; ' +
                        '  fi; ' +
                        'fi; ' +
                        'SRV_ID=$(sqlite3 /mnt/systemrw/tvs-chms/data/dvbs "INSERT INTO SRV (chId, major, minor, progNum, srvName, srvType, tsid, vidEncType, vidPid, pcr, lockMode, mem, memBySI, elim, hideGuide, hidden, srv3d, scrambled, scrmInPMT, numSel, plpId, cacheId, resInfoType, resInfoWidth, resInfoHeight, resInfoFrNum, resInfoFrDenom, htlProgType, modifiedByUser, caDevId, caSrvType, caDevType, ipg, srcType, isAtscUHD, imclOrder, delSys, defSrv, hfr, uhd, subsetVidPid, mrp, sync, recState) VALUES ($CH_ID, $MAJOR, 65534, $PROG_NUM, CAST(X\'' + hexName + '\' AS TEXT), 1, 1, 1, $VID_PID, $PCR, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1, 65535, 4091, -1, -1, -1, -1, 0, -1, 1, \'\', 0, -1, 0, 0, 0, 65535, -1, \'\', 0, 0, 65535, -1, \'\', NULL); SELECT last_insert_rowid();"); ' +
                        'sqlite3 /mnt/systemrw/tvs-chms/data/dvbs "INSERT INTO SRV_DVB (srvId, nid, onid, lcn, hdLcn, hdSim, srvStat, provId, eitPf, mltLngSrvNameLang, updByPsi) VALUES ($SRV_ID, 65535, 100, $MAJOR, 65535, 0, 0, 1970333629055258, 0, 65535, 1);"; ' +
                        'sqlite3 /mnt/systemrw/tvs-chms/data/dvbs "PRAGMA wal_checkpoint(TRUNCATE);"; ' +
                        'sqlite3 /mnt/systemrw/tvs-chms/data/sat "PRAGMA wal_checkpoint(TRUNCATE);"; ' +
                        'echo "$MAJOR $TP_ID $CH_ID $SRV_ID"';

                    ctx.execute(addCmd, 12000).then(function (r) {
                        cachedChannels = null;
                        var lines = (r.stdout || '').trim().split('\n');
                        var lastLine = lines[lines.length - 1].trim();
                        var parts = lastLine.split(' ');
                        var createdMajor = parseInt(parts[0], 10) || major;
                        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
                        res.end(JSON.stringify({
                            ok: true,
                            message: 'Channel #' + createdMajor + ' (' + name + ') added successfully!',
                            channel: {
                                num: createdMajor,
                                name: name,
                                freq: Math.round(freqKhz / 1000),
                                pol: pol,
                                sr: sr
                            }
                        }));
                    }).catch(function (e) {
                        res.writeHead(500, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
                        res.end(JSON.stringify({ ok: false, error: e.message }));
                    });
                });
                return true;
            }

            // GET api/export — export official Samsung Channel_list_<Version>.zip
            if ((sub === 'export' || action === 'export') && req.method === 'GET') {
                var exportCmd = 'PRD="/etc/prd_info.ini"; ' +
                    'VER=""; ' +
                    'if [ -f "$PRD" ]; then VER=$(grep -i "^Version=" "$PRD" | head -n 1 | cut -d "=" -f2 | tr -d ";\\r\\n "); fi; ' +
                    'if [ -z "$VER" ]; then VER="backup"; fi; ' +
                    'ZIPNAME="Channel_list_${VER}.zip"; ' +
                    'ZIPPATH="/tmp/${ZIPNAME}"; ' +
                    'rm -f /tmp/Channel_list_*.zip; ' +
                    'mkdir -p /tmp/ch_export; ' +
                    'cd /mnt/systemrw/tvs-chms/data/ || exit 1; ' +
                    'if [ -f dvbs ]; then sqlite3 dvbs "PRAGMA wal_checkpoint(TRUNCATE);"; fi; ' +
                    'if [ -f ipsrv ]; then sqlite3 ipsrv "PRAGMA wal_checkpoint(TRUNCATE);"; fi; ' +
                    'FILES=""; ' +
                    'for f in dvbs sat ipsrv dvbt dvbc metadata.xml; do ' +
                    '  if [ -f "$f" ]; then FILES="$FILES $f"; fi; ' +
                    'done; ' +
                    'if [ ! -f "metadata.xml" ]; then ' +
                    '  cat << \'EOFXML\' > /tmp/ch_export/metadata.xml\n' +
                    '<?xml version="1.0" encoding="UTF-8"?>\n' +
                    '<TVS_XML_STORAGE>\n' +
                    '\t<ANALOG_COUNTRY>48</ANALOG_COUNTRY>\n' +
                    '\t<DIGITAL_COUNTRY>5198920</DIGITAL_COUNTRY>\n' +
                    '\t<SEI_VERSION>101</SEI_VERSION>\n' +
                    '</TVS_XML_STORAGE>\n' +
                    'EOFXML\n' +
                    '  FILES="$FILES /tmp/ch_export/metadata.xml"; ' +
                    'fi; ' +
                    '/usr/bin/zip -j "$ZIPPATH" $FILES >/dev/null 2>&1; ' +
                    'echo "$ZIPNAME"';

                ctx.execute(exportCmd, 12000)
                    .then(function (r) {
                        var lines = (r.stdout || '').trim().split('\n');
                        var zipName = lines[lines.length - 1].trim();
                        if (!zipName || zipName.indexOf('Channel_list_') !== 0) {
                            zipName = 'Channel_list_backup.zip';
                        }
                        var fullZipPath = '/tmp/' + zipName;
                        try {
                            var stat = fs.statSync(fullZipPath);
                            res.writeHead(200, {
                                'content-type': 'application/zip',
                                'content-disposition': 'attachment; filename="' + zipName + '"',
                                'access-control-expose-headers': 'content-disposition',
                                'access-control-allow-origin': '*',
                                'content-length': stat.size,
                                'cache-control': 'no-store'
                            });
                            var readStream = fs.createReadStream(fullZipPath);
                            readStream.pipe(res);
                            readStream.on('close', function () {
                                try { fs.unlinkSync(fullZipPath); } catch (e) {}
                                try { fs.unlinkSync('/tmp/ch_export/metadata.xml'); } catch (e) {}
                            });
                        } catch (err) {
                            res.writeHead(500, { 'content-type': 'application/json' });
                            res.end(JSON.stringify({ ok: false, error: 'Could not generate zip archive: ' + err.message }));
                        }
                    })
                    .catch(function (e) {
                        res.writeHead(500, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: e.message }));
                    });
                return true;
            }

            // POST api/import — import Samsung Channel_list_*.zip archive
            if ((sub === 'import' || action === 'import') && req.method === 'POST') {
                var uploadZip = '/tmp/channels_upload_' + Date.now() + '.zip';
                var outStream = fs.createWriteStream(uploadZip);
                req.pipe(outStream);
                outStream.on('finish', function () {
                    var importCmd = 'if ! /usr/bin/unzip -t "' + uploadZip + '" >/dev/null 2>&1; then ' +
                        '  rm -f "' + uploadZip + '"; echo "INVALID_ZIP"; exit 1; ' +
                        'fi; ' +
                        'rm -rf /tmp/ch_import_temp && mkdir -p /tmp/ch_import_temp; ' +
                        '/usr/bin/unzip -o -q "' + uploadZip + '" -d /tmp/ch_import_temp/; ' +
                        'FOUND=0; ' +
                        'for f in dvbs sat ipsrv dvbt dvbc; do ' +
                        '  if [ -f "/tmp/ch_import_temp/$f" ]; then FOUND=1; break; fi; ' +
                        'done; ' +
                        'if [ $FOUND -eq 0 ]; then ' +
                        '  rm -rf /tmp/ch_import_temp "' + uploadZip + '"; echo "NO_CHANNELS_FOUND"; exit 2; ' +
                        'fi; ' +
                        'for f in dvbs sat ipsrv dvbt dvbc metadata.xml; do ' +
                        '  if [ -f "/tmp/ch_import_temp/$f" ]; then ' +
                        '    cp "/tmp/ch_import_temp/$f" "/mnt/systemrw/tvs-chms/data/$f"; ' +
                        '  fi; ' +
                        'done; ' +
                        '[ -f /mnt/systemrw/tvs-chms/data/dvbs ] && sqlite3 /mnt/systemrw/tvs-chms/data/dvbs "PRAGMA wal_checkpoint(TRUNCATE);"; ' +
                        '[ -f /mnt/systemrw/tvs-chms/data/ipsrv ] && sqlite3 /mnt/systemrw/tvs-chms/data/ipsrv "PRAGMA wal_checkpoint(TRUNCATE);"; ' +
                        'pkill -9 tvs-daemon; sleep 0.5; ' +
                        'rm -rf /tmp/ch_import_temp "' + uploadZip + '"; ' +
                        'echo "SUCCESS"';

                    ctx.execute(importCmd, 15000)
                        .then(function (r) {
                            cachedChannels = null;
                            var out = (r.stdout || '').trim();
                            if (out.indexOf('INVALID_ZIP') >= 0) {
                                res.writeHead(400, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
                                res.end(JSON.stringify({ ok: false, error: 'The uploaded file is not a valid zip archive.' }));
                                return;
                            }
                            if (out.indexOf('NO_CHANNELS_FOUND') >= 0) {
                                res.writeHead(400, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
                                res.end(JSON.stringify({ ok: false, error: 'No channel databases (dvbs, ipsrv, dvbt) found inside the archive.' }));
                                return;
                            }
                            res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
                            res.end(JSON.stringify({ ok: true, message: 'Channels imported successfully and TV tuner reloaded!' }));
                        })
                        .catch(function (e) {
                            try { fs.unlinkSync(uploadZip); } catch (err) {}
                            res.writeHead(500, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
                            res.end(JSON.stringify({ ok: false, error: e.message }));
                        });
                });
                outStream.on('error', function (err) {
                    try { fs.unlinkSync(uploadZip); } catch (e) {}
                    res.writeHead(500, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
                    res.end(JSON.stringify({ ok: false, error: err.message }));
                });
                return true;
            }

            return false;
        }
    };
};
