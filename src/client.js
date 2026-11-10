// Keeps relative times and "stale" badges correct while the page sits open,
// since the HTML is only rebuilt when a status file changes.
(function () {
  var STALE_MS = 14 * 24 * 60 * 60 * 1000;
  var DIVISIONS = [
    [60, 'second'], [60, 'minute'], [24, 'hour'], [7, 'day'],
    [4.34524, 'week'], [12, 'month'], [Infinity, 'year'],
  ];
  var rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  var abs = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  function relative(iso, now) {
    var amount = (Date.parse(iso) - now) / 1000;
    for (var i = 0; i < DIVISIONS.length; i++) {
      if (Math.abs(amount) < DIVISIONS[i][0]) return rtf.format(Math.round(amount), DIVISIONS[i][1]);
      amount /= DIVISIONS[i][0];
    }
    return iso;
  }

  function update() {
    var now = Date.now();
    document.querySelectorAll('time[data-rel]').forEach(function (el) {
      var iso = el.getAttribute('datetime');
      el.textContent = relative(iso, now);
      el.title = abs.format(new Date(iso));
    });
    document.querySelectorAll('time[data-abs]').forEach(function (el) {
      el.textContent = abs.format(new Date(el.getAttribute('datetime')));
    });
    document.querySelectorAll('[data-stale-for]').forEach(function (el) {
      el.hidden = now - Date.parse(el.getAttribute('data-stale-for')) <= STALE_MS;
    });
  }

  update();
  setInterval(update, 60 * 1000);

  // Views: one static page, the hash picks what shows (#/overview, #/p/nova),
  // so Back works and a project page can be linked.
  var views = Array.prototype.slice.call(document.querySelectorAll('.view'));
  var tabs = document.querySelectorAll('[data-tab]');
  var scrollBy = {};
  var shown = null;
  // In split view the right side scrolls in its own box, not the window.
  var pageBox = document.querySelector('main.page');
  function splitOn() { return document.body.classList.contains('split') && !!pageBox; }
  function rightScroll() { return splitOn() ? pageBox.scrollTop : window.scrollY; }
  function scrollRight(y) {
    if (splitOn()) pageBox.scrollTop = y; else window.scrollTo(0, y);
  }
  function route() {
    var raw = location.hash;
    // Links from before the views existed: #project-nova.
    var old = /^#project-(.+)$/.exec(raw);
    if (old) { location.replace('#/p/' + old[1]); return; }
    // "?range=4w" picks the Activity and Builds range, not a view.
    var name = decodeURIComponent(raw.replace(/^#\/?/, '').split('?')[0]) || 'desktop';
    // The project list joined the Overview; old links still land there.
    if (name === 'projects') { location.replace('#/overview'); return; }
    var view = views.filter(function (v) { return v.getAttribute('data-view') === name; })[0] || views[0];
    if (view === shown) return;
    var first = shown === null;
    views.forEach(function (v) { v.hidden = v !== view; });
    shown = view;
    var key = view.getAttribute('data-view');
    var tab = key.indexOf('p/') === 0 ? 'overview' : key;
    tabs.forEach(function (t) {
      if (t.getAttribute('data-tab') === tab) t.setAttribute('aria-current', 'page');
      else t.removeAttribute('aria-current');
    });
    document.title = key === 'desktop' ? 'Projects' : view.getAttribute('data-title') + ' · Projects';
    if (!first) {
      // Back to a list lands where you left it; a project page starts at the top.
      scrollRight(tab === key ? scrollBy[key] || 0 : 0);
      var heading = view.querySelector('h2[tabindex]');
      if (heading) heading.focus({ preventScroll: true });
    }
  }
  if (views.length) {
    route();
    window.addEventListener('hashchange', route);
    // Recorded as it happens: by the time hashchange fires, the browser has
    // already jumped to the top, so reading scrollY then always gives 0.
    var remember = function () {
      if (shown) scrollBy[shown.getAttribute('data-view')] = rightScroll();
    };
    window.addEventListener('scroll', remember, { passive: true });
    if (pageBox) pageBox.addEventListener('scroll', remember, { passive: true });
  }

  // Split view: one project pinned on the left of a wide screen, a
  // copy of its page, while the right side keeps routing as usual. Each
  // project's small menu pins it, or in split view swaps or closes a side
  //. Kept per browser; CSS hides the menu and the column below 1100px.
  var pinnedBox = document.querySelector('.pinned');
  var pinned = null;
  try { pinned = localStorage.getItem('pinned'); } catch (e) { /* storage blocked */ }
  function projectView(name) {
    return views.filter(function (v) { return v.getAttribute('data-view') === 'p/' + name; })[0] || null;
  }
  function rightProject() {
    var key = shown && shown.getAttribute('data-view');
    return key && key.indexOf('p/') === 0 ? key.slice(2) : null;
  }
  function savePin(name) {
    pinned = name;
    try {
      if (pinned) localStorage.setItem('pinned', pinned); else localStorage.removeItem('pinned');
    } catch (e) { /* storage blocked: the pin lasts for this page view */ }
  }
  function syncMenus() {
    var split = !!(pinned && projectView(pinned));
    var right = rightProject();
    document.querySelectorAll('.side-menu').forEach(function (m) {
      var act = function (a) { return m.querySelector('[data-side-act="' + a + '"]'); };
      act('pin').hidden = split;
      // Swapping a project with itself changes nothing.
      act('swap').hidden = !split || !right || right === pinned;
      act('close').hidden = !split;
    });
  }
  function showPinned() {
    if (!pinnedBox) return;
    var src = pinned ? projectView(pinned) : null;
    pinnedBox.textContent = '';
    if (src) {
      var copy = src.cloneNode(true);
      // A copy, not the page itself: the same project can be open on the right
      // too, so no ids or routing attributes may repeat.
      copy.hidden = false;
      copy.classList.remove('view');
      ['id', 'data-view', 'data-title', 'aria-labelledby'].forEach(function (a) { copy.removeAttribute(a); });
      copy.querySelectorAll('[id]').forEach(function (el) { el.removeAttribute('id'); });
      copy.querySelectorAll('[tabindex]').forEach(function (el) { el.removeAttribute('tabindex'); });
      // Same height as the back link on the right, so both headings line up.
      var back = copy.querySelector('.back');
      if (back) {
        var label = document.createElement('span');
        label.className = 'pinned-label';
        label.textContent = 'Pinned';
        back.replaceWith(label);
      }
      pinnedBox.appendChild(copy);
    }
    pinnedBox.hidden = !src;
    document.body.classList.toggle('split', !!src);
    syncMenus();
  }
  document.addEventListener('click', function (ev) {
    var open = document.querySelectorAll('.side-menu[open]');
    var b = ev.target.closest && ev.target.closest('[data-side-act]');
    open.forEach(function (m) { if (!m.contains(ev.target) || b) m.open = false; });
    if (!b) return;
    var act = b.getAttribute('data-side-act');
    var onLeft = !!b.closest('.pinned');
    var right = rightProject();
    if (act === 'pin') {
      var name = b.getAttribute('data-project');
      savePin(name);
      showPinned();
      // The page is on the left now; the right side goes to the list to pick
      // the second project.
      if (right === name) location.hash = '#/overview';
    } else if (act === 'swap') {
      var was = pinned;
      savePin(right);
      showPinned();
      location.hash = '#/p/' + encodeURIComponent(was);
    } else if (act === 'close') {
      var left = pinned;
      savePin(null);
      showPinned();
      // Closing the right side leaves the pinned project as the whole page.
      if (!onLeft) location.hash = '#/p/' + encodeURIComponent(left);
    }
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') document.querySelectorAll('.side-menu[open]').forEach(function (m) { m.open = false; });
  });
  window.addEventListener('hashchange', syncMenus);
  showPinned();

  // Range on Activity and Builds: one choice for both views, from the link
  // (#/activity?range=4w), else the last one picked in this browser.
  var rangeInputs = document.querySelectorAll('input[name^="range-"]');
  function setRange(key) {
    var known = false;
    rangeInputs.forEach(function (i) { if (i.value === key) known = true; });
    if (!known) return;
    rangeInputs.forEach(function (i) { i.checked = i.value === key; });
  }
  if (rangeInputs.length) {
    var linked = /[?&]range=([^&]+)/.exec(location.hash);
    var stored = null;
    try { stored = localStorage.getItem('range'); } catch (e) { /* storage blocked */ }
    setRange(linked ? decodeURIComponent(linked[1]) : stored);
    rangeInputs.forEach(function (input) {
      input.addEventListener('change', function () {
        setRange(input.value);
        try { localStorage.setItem('range', input.value); } catch (e) { /* storage blocked: the choice lasts for this page view */ }
        var view = location.hash.replace(/^#\/?/, '').split('?')[0];
        if (view === 'activity' || view === 'builds') history.replaceState(null, '', '#/' + view + '?range=' + input.value);
      });
    });
  }

  // Install: Chrome and Android offer beforeinstallprompt; iPhone has no such
  // event, so the button there explains Share → Add to Home Screen.
  var installBtn = document.querySelector('.install');
  var hint = document.querySelector('.install-hint');
  var deferred = null;
  var standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  var ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (installBtn && !standalone) {
    window.addEventListener('beforeinstallprompt', function (ev) {
      ev.preventDefault();
      deferred = ev;
      installBtn.hidden = false;
    });
    if (ios) installBtn.hidden = false;
    installBtn.addEventListener('click', function () {
      if (deferred) {
        deferred.prompt();
        deferred.userChoice.then(function (c) { if (c.outcome === 'accepted') installBtn.hidden = true; });
        deferred = null;
      } else if (hint) {
        hint.hidden = !hint.hidden;
      }
    });
    window.addEventListener('appinstalled', function () { installBtn.hidden = true; if (hint) hint.hidden = true; });
    if (hint) hint.querySelector('.install-hint-close').addEventListener('click', function () { hint.hidden = true; });
  }
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(function () { /* the page works without it */ });
  }

  // Theme button: Light ⇄ Dark, remembered per browser. Until the first tap
  // the page follows the system, and the button shows what is on screen.
  var root = document.documentElement;
  var toggle = document.querySelector('.theme-toggle');
  var systemDark = window.matchMedia('(prefers-color-scheme: dark)');
  var themeMetas = document.querySelectorAll('meta[name="theme-color"]');
  function effective() {
    return root.dataset.theme || (systemDark.matches ? 'dark' : 'light');
  }
  function showTheme() {
    var current = effective();
    // The app's title bar follows a chosen theme, not only the system one.
    themeMetas.forEach(function (m) {
      if (!m.dataset.auto) m.dataset.auto = m.content;
      m.content = root.dataset.theme === 'light' ? '#f6f5f2' : root.dataset.theme === 'dark' ? '#121417' : m.dataset.auto;
    });
    if (!toggle) return;
    var next = current === 'dark' ? 'light' : 'dark';
    toggle.setAttribute('data-current', current);
    toggle.setAttribute('aria-label', 'Switch to ' + next + ' theme');
    toggle.title = 'Switch to ' + next + ' theme';
  }
  if (toggle) {
    toggle.addEventListener('click', function () {
      var choice = effective() === 'dark' ? 'light' : 'dark';
      root.dataset.theme = choice;
      try { localStorage.setItem('theme', choice); } catch (e) { /* storage blocked: the choice lasts for this page view */ }
      showTheme();
    });
  }
  systemDark.addEventListener('change', showTheme);
  showTheme();

  // New-deploy notice: poll version.json and offer a reload when it changes.
  var meta = document.querySelector('meta[name="dashboard-version"]');
  var mine = meta && meta.content;
  var toast = document.querySelector('.update-toast');
  var dismissed = null;
  var text = toast && toast.querySelector('.update-text');
  var NEW_TEXT = 'A new version of this page is available.';
  var EXPIRED_TEXT = 'Your sign-in has expired. Reload to sign in and see the latest version.';
  function show(message) {
    text.textContent = message;
    toast.hidden = false;
  }
  function checkVersion() {
    if (!mine || !toast) return;
    // redirect: 'manual' because an expired Access session answers with a
    // redirect to the Access login on another origin. Followed, that fails
    // CORS and looks exactly like being offline, so a tab left open past its
    // session never heard about a deploy again.
    fetch('version.json?t=' + Date.now(), { cache: 'no-store', credentials: 'same-origin', redirect: 'manual' })
      .then(function (r) {
        if (r.type === 'opaqueredirect') {
          if (dismissed !== 'expired') show(EXPIRED_TEXT);
          return null;
        }
        return r.ok ? r.json() : null;
      })
      .then(function (data) {
        var latest = data && data.version;
        if (latest && latest !== mine && latest !== dismissed) show(NEW_TEXT);
      })
      // Offline: try again later.
      .catch(function () {});
  }
  if (toast) {
    toast.querySelector('.update-now').addEventListener('click', function () {
      // Refresh the cached copy first; a plain reload can show the old page from cache.
      fetch(location.href, { cache: 'reload', credentials: 'same-origin' })
        .catch(function () {})
        .then(function () { location.reload(); });
    });
    toast.querySelector('.update-later').addEventListener('click', function () {
      toast.hidden = true;
      if (text.textContent === EXPIRED_TEXT) { dismissed = 'expired'; return; }
      // Stay quiet about this version; a newer one still shows the notice.
      fetch('version.json?t=' + Date.now(), { cache: 'no-store', credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (d) { dismissed = d.version; })
        .catch(function () {});
    });
  }
  setInterval(checkVersion, 60 * 1000);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') checkVersion();
  });
  // Desktop: every app is a plain link that opens in a new tab (the
  // owner's choice; windows on the page were removed). An icon that fails to
  // load leaves its letter tile showing.
  var desk = document.querySelector('.desktop');
  if (desk) {
    desk.addEventListener('error', function (ev) {
      if (ev.target.tagName === 'IMG') ev.target.remove();
    }, true);
  }
})();
