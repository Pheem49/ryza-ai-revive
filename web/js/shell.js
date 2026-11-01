/* Frameless-window controls for the desktop (Electron) shell.
   Browser / Android builds never see window.ryzaShell, so nothing shows. */
(function (global) {
  'use strict';
  if (!global.ryzaShell) return;

  function build() {
    var bar = document.getElementById('topbar');
    if (!bar || document.getElementById('winctl')) return;

    var ctl = document.createElement('div');
    ctl.id = 'winctl';
    var mk = function (id, glyph, title) {
      var b = document.createElement('button');
      b.type = 'button';
      b.id = id;
      b.className = 'icon-btn win-btn';
      b.textContent = glyph;
      b.title = title;
      ctl.appendChild(b);
      return b;
    };
    var pin = mk('win-pin', '📌', (global.I18n && I18n.t ? I18n.t('win.pin') : 'Pin on top'));
    var min = mk('win-min', '—', (global.I18n && I18n.t ? I18n.t('win.min') : 'Minimize'));
    var cls = mk('win-close', '✕', (global.I18n && I18n.t ? I18n.t('win.close') : 'Close'));
    /* 窗口控件挂在顶栏末尾。这里曾经想在「设置」按钮后面插入，
       但官方 UI 改版后设置入口搬进了侧边菜单（`#sm-settings`），
       `#btn-settings` 已经不存在 —— 那半个分支永远走不到，删掉。 */
    bar.appendChild(ctl);

    pin.onclick = function () {
      global.ryzaShell.setTopmost(!pin.classList.contains('on')).then(function (on) {
        pin.classList.toggle('on', !!on);
      });
    };
    min.onclick = function () { global.ryzaShell.minimize(); };
    cls.onclick = function () { global.ryzaShell.close(); };
    global.ryzaShell.isTopmost().then(function (on) { pin.classList.toggle('on', !!on); });

    /* Drag the frameless window by the HUD strip; buttons stay clickable. */
    document.body.classList.add('shell-electron');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})(window);
