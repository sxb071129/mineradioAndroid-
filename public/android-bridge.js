(function () {
  if (!window.MineradioAndroid || window.desktopWindow) return;

  var pending = {};
  var nextToken = 1;

  function parseResult(raw) {
    if (!raw) return { ok: true };
    try { return JSON.parse(String(raw)); }
    catch (e) { return { ok: false, error: e.message || String(e) }; }
  }

  function callNative(method, payload) {
    try {
      if (!window.MineradioAndroid || typeof window.MineradioAndroid[method] !== 'function') {
        return { ok: false, error: 'ANDROID_BRIDGE_METHOD_MISSING' };
      }
      return parseResult(window.MineradioAndroid[method](JSON.stringify(payload || {})));
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  }

  function callNativeAsync(method, payload, timeoutMs) {
    var token = 'android_' + Date.now() + '_' + (nextToken++);
    payload = payload || {};
    payload.token = token;
    var started = callNative(method, payload);
    if (!started || started.ok === false) return Promise.resolve(started || { ok: false, error: 'ANDROID_BRIDGE_FAILED' });
    return new Promise(function (resolve) {
      var timer = setTimeout(function () {
        if (!pending[token]) return;
        delete pending[token];
        resolve({ ok: false, error: 'ANDROID_BRIDGE_TIMEOUT' });
      }, timeoutMs || 300000);
      pending[token] = function (result) {
        clearTimeout(timer);
        resolve(result || { ok: true });
      };
    });
  }

  window.__mineradioAndroidResolve = function (token, result) {
    var done = pending[token];
    if (!done) return;
    delete pending[token];
    done(result || { ok: true });
  };

  function promiseResult(method, payload) {
    return Promise.resolve(callNative(method, payload || {}));
  }

  var noopOk = function () { return Promise.resolve({ ok: true, androidNoop: true }); };
  var unsubscribe = function () { return function () {}; };

  window.desktopWindow = {
    isDesktop: true,
    isAndroid: true,
    minimize: noopOk,
    toggleMaximize: noopOk,
    toggleFullscreen: noopOk,
    exitFullscreenWindowed: noopOk,
    close: noopOk,
    getState: function () { return promiseResult('getState'); },
    openNeteaseMusicLogin: function () { return callNativeAsync('openLogin', { provider: 'netease' }); },
    clearNeteaseMusicLogin: function () { return promiseResult('clearLogin', { provider: 'netease' }); },
    openQQMusicLogin: function () { return callNativeAsync('openLogin', { provider: 'qq' }); },
    clearQQMusicLogin: function () { return promiseResult('clearLogin', { provider: 'qq' }); },
    openKugouMusicLogin: function () { return callNativeAsync('openLogin', { provider: 'kugou' }); },
    clearKugouMusicLogin: function () { return promiseResult('clearLogin', { provider: 'kugou' }); },
    openUpdateInstaller: function (filePath) { return promiseResult('openUpdateInstaller', { filePath: filePath || '' }); },
    restartApp: function () { return promiseResult('restartApp'); },
    setPlaybackActive: function (payload) { return promiseResult('setPlaybackActive', payload || {}); },
    configureGlobalHotkeys: function () { return Promise.resolve({ ok: true, results: [], androidNoop: true }); },
    exportJsonFile: function (payload) { return callNativeAsync('exportJsonFile', payload || {}, 60000); },
    importJsonFile: function () { return callNativeAsync('importJsonFile', {}, 300000); },
    setDesktopLyricsEnabled: noopOk,
    updateDesktopLyrics: noopOk,
    setWallpaperMode: noopOk,
    updateWallpaperMode: noopOk,
    onGlobalHotkey: unsubscribe,
    onDesktopLyricsLockState: unsubscribe,
    onDesktopLyricsEnabledState: unsubscribe,
    onStateChange: unsubscribe,
    openExternal: function (url) { return promiseResult('openExternal', { url: url || '' }); }
  };

  document.documentElement.classList.add('android-shell-root');
  window.addEventListener('DOMContentLoaded', function () {
    document.body.classList.add('android-shell');
  });
})();
