/*
 * The public link's page (Apache-2.0): decrypts what the owner shared, in the visitor's browser.
 *
 * The key is the link's `#` part: a browser never sends it to a server, so the Sphere, its logs and
 * whatever stands in front of it see only ciphertext. The page fetches that ciphertext from its own
 * origin (`connect-src 'self'`), decrypts it with age (vendor/age.bundle.js, typage), unpacks the tar
 * the owner's obid made, and shows the files from memory (`blob:` URLs) in a frame sandboxed
 * `allow-scripts`: nothing it shows can reach this page, the Sphere or the key.
 *
 * `window.__OBY_PUBLIC` says what happened ({ready, error, kind, title, files}), for tests.
 *
 * Served by the Obysphere at /a/viewer.js (spec/sphere-api.md section 11), whatever page loads it:
 * the Obysphere's own, or the one the link's owner's client uploaded, which pins it by its SRI
 * hash. From oby's lab (tools/obid-spec/lab-ui/artifacts/public/viewer.js), with the link's id
 * read from the path when the page doesn't say it, and the key taken out of the address once read.
 */
(function () {
  'use strict';
  var state = (window.__OBY_PUBLIC = { ready: false, error: null, kind: null, title: null, files: [] });
  // The link's id: the page's own, or, on the Obysphere's page, its path (/a/<linkId>).
  var link = document.body.getAttribute('data-link') || decodeURIComponent(location.pathname.split('/')[2] || '');
  var status = document.getElementById('status');
  var view = document.getElementById('view');

  function done() {
    state.ready = true;
    document.documentElement.setAttribute('data-oby-public', 'ready');
  }

  function fail(words) {
    state.error = words;
    status.textContent = words;
    done();
  }

  var utf8 = new TextDecoder();

  function field(h, at, n) {
    var end = at;
    while (end < at + n && h[end]) end++;
    return utf8.decode(h.subarray(at, end));
  }

  /** The tar obid writes: ustar, plain files only (a link or anything else was refused before). */
  function untar(b) {
    var files = {};
    var at = 0;
    while (at + 512 <= b.length) {
      var h = b.subarray(at, at + 512);
      if (h.every(function (x) { return x === 0; })) break;
      var name = field(h, 0, 100);
      var prefix = field(h, 345, 155);
      if (prefix) name = prefix + '/' + name;
      var size = parseInt(field(h, 124, 12).trim() || '0', 8);
      var type = h[156];
      at += 512;
      if (type === 48 || type === 0) files[name] = b.slice(at, at + size);
      at += Math.ceil(size / 512) * 512;
    }
    return files;
  }

  var TYPES = {
    html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', json: 'application/json',
    svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', avif: 'image/avif', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
    otf: 'font/otf', md: 'text/plain', txt: 'text/plain', pdf: 'application/pdf', mp4: 'video/mp4', webm: 'video/webm',
  };

  function typeOf(name) {
    var e = name.split('.').pop().toLowerCase();
    return TYPES[e] || 'application/octet-stream';
  }

  function frame(url) {
    var f = document.createElement('iframe');
    f.setAttribute('sandbox', 'allow-scripts');
    f.setAttribute('title', state.title || 'Shared');
    f.src = url;
    view.appendChild(f);
  }

  function show(files) {
    var names = Object.keys(files).sort();
    state.files = names;
    var urls = {};
    names.forEach(function (n) {
      urls[n] = URL.createObjectURL(new Blob([files[n]], { type: typeOf(n) }));
    });
    status.remove();
    if (files['index.html']) {
      state.kind = 'html';
      var html = utf8.decode(files['index.html']);
      var t = /<title>([^<]*)<\/title>/i.exec(html);
      state.title = t ? t[1] : null;
      // The page's own files, from memory: each src, href and url() naming one.
      html = html.replace(/((?:src|href)\s*=\s*")([^"#?]+)(")|(url\(\s*['"]?)([^'")]+)(['"]?\s*\))/gi, function (all, a, p, z, a2, p2, z2) {
        var path = (p || p2 || '').replace(/^\.\//, '');
        return urls[path] ? (a || a2) + urls[path] + (z || z2) : all;
      });
      frame(URL.createObjectURL(new Blob([html], { type: 'text/html' })));
    } else if (files['canvas.json']) {
      state.kind = 'design';
      var canvas = JSON.parse(utf8.decode(files['canvas.json']));
      state.title = canvas.title || null;
      var list = document.createElement('ol');
      Object.keys(canvas.boards || {}).forEach(function (b) {
        var li = document.createElement('li');
        li.textContent = (canvas.boards[b] && canvas.boards[b].title) || b;
        list.appendChild(li);
      });
      view.appendChild(list);
    } else if (names.length === 1 && /\.(md|markdown|txt)$/i.test(names[0])) {
      state.kind = 'markdown';
      var pre = document.createElement('pre');
      pre.textContent = utf8.decode(files[names[0]]);
      view.appendChild(pre);
    } else if (names.length === 1) {
      state.kind = /\.pdf$/i.test(names[0]) ? 'pdf' : 'image';
      frame(urls[names[0]]);
    }
    done();
  }

  var key = decodeURIComponent(location.hash.slice(1));
  // The key leaves the address bar, the history and anything that copies the page's address from
  // now on: it lives in this script alone.
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  if (!key) {
    fail('This link is missing its key: copy the whole link.');
    return;
  }
  fetch('/a/' + encodeURIComponent(link) + '/blob', { cache: 'no-store', credentials: 'omit' })
    .then(function (r) {
      if (r.status === 404) throw new Error('taken back');
      if (!r.ok) throw new Error('status ' + r.status);
      return r.arrayBuffer();
    })
    .then(function (buf) {
      var d = new window.obyAge.Decrypter();
      d.addIdentity(key);
      return d.decrypt(new Uint8Array(buf), 'uint8array');
    })
    .then(function (tar) {
      show(untar(tar));
    })
    .catch(function (e) {
      fail(e.message === 'taken back' ? 'This link was taken back.' : 'This link can’t be opened.');
    });
})();
