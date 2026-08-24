; (function () {
  try {
    var stored = JSON.parse(localStorage.getItem('sangam.workspace-preferences.v1') || '{}')
    var root = document.documentElement
    var data = root.dataset
    if (['system', 'inter', 'plex', 'serif'].indexOf(stored.uiFont) !== -1) data.uiFont = stored.uiFont
    if (['compact', 'default', 'comfortable'].indexOf(stored.uiDensity) !== -1)
      data.uiDensity = stored.uiDensity
    if (['small', 'default', 'large'].indexOf(stored.editorSize) !== -1)
      data.editorSize = stored.editorSize
    var custom = stored.customTheme
    if (
      custom &&
      custom.accent &&
      /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(custom.accent) &&
      ['river', 'midnight', 'parchment', 'cobalt'].indexOf(custom.base) !== -1
    ) {
      data.theme = custom.base
      root.style.setProperty('--accent', custom.accent)
      var hex = custom.accent.replace('#', '')
      if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2]
      var r = parseInt(hex.slice(0, 2), 16)
      var g = parseInt(hex.slice(2, 4), 16)
      var b = parseInt(hex.slice(4, 6), 16)
      root.style.setProperty('--accent-soft', 'rgba(' + r + ', ' + g + ', ' + b + ', 0.16)')
      var channels = [r, g, b].map(function (raw) {
        var c = raw / 255
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
      })
      var luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
      root.style.setProperty('--accent-text', luminance > 0.4 ? '#101318' : '#f7f8f8')
    }
  } catch (error) {}
})()
