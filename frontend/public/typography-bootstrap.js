; (function () {
  var OVERRIDE_TOKENS = [
    '--app-bg',
    '--surface',
    '--surface-soft',
    '--text',
    '--muted',
    '--line',
    '--sidebar',
    '--sidebar-text',
    '--accent',
    '--accent-soft',
    '--accent-text',
  ]
  var ROLES = [
    'appBg',
    'surface',
    'surfaceSoft',
    'text',
    'muted',
    'line',
    'sidebar',
    'sidebarText',
    'accent',
  ]
  var TOKEN_BY_ROLE = {
    appBg: '--app-bg',
    surface: '--surface',
    surfaceSoft: '--surface-soft',
    text: '--text',
    muted: '--muted',
    line: '--line',
    sidebar: '--sidebar',
    sidebarText: '--sidebar-text',
    accent: '--accent',
  }
  function hexToRgba(hex, alpha) {
    var value = hex.replace('#', '')
    if (value.length === 3) value = value[0] + value[0] + value[1] + value[1] + value[2] + value[2]
    var r = parseInt(value.slice(0, 2), 16)
    var g = parseInt(value.slice(2, 4), 16)
    var b = parseInt(value.slice(4, 6), 16)
    return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alpha + ')'
  }
  function readableText(hex) {
    var value = hex.replace('#', '')
    if (value.length === 3) value = value[0] + value[0] + value[1] + value[1] + value[2] + value[2]
    var channels = [0, 2, 4].map(function (i) {
      var c = parseInt(value.slice(i, i + 2), 16) / 255
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
    })
    var luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
    return luminance > 0.4 ? '#101318' : '#f7f8f8'
  }
  try {
    var stored = JSON.parse(localStorage.getItem('sangam.workspace-preferences.v1') || '{}')
    var root = document.documentElement
    var data = root.dataset
    if (['system', 'inter', 'plex', 'serif'].indexOf(stored.uiFont) !== -1) data.uiFont = stored.uiFont
    if (['compact', 'default', 'comfortable'].indexOf(stored.uiDensity) !== -1)
      data.uiDensity = stored.uiDensity
    if (['small', 'default', 'large'].indexOf(stored.editorSize) !== -1)
      data.editorSize = stored.editorSize
    var custom = null
    if (
      typeof stored.theme === 'string' &&
      stored.theme.indexOf('custom:') === 0 &&
      Array.isArray(stored.customThemes)
    ) {
      var id = stored.theme.slice('custom:'.length)
      custom = stored.customThemes.find(function (entry) {
        return entry.id === id
      })
    }
    if (custom && custom.base) {
      data.theme = custom.base
      for (var i = 0; i < ROLES.length; i++) {
        var role = ROLES[i]
        if (custom.colors && custom.colors[role]) {
          root.style.setProperty(TOKEN_BY_ROLE[role], custom.colors[role])
        }
      }
      if (custom.colors && custom.colors.accent && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(custom.colors.accent)) {
        root.style.setProperty('--accent-soft', hexToRgba(custom.colors.accent, 0.16))
        root.style.setProperty('--accent-text', readableText(custom.colors.accent))
      }
    } else if (['river', 'midnight', 'parchment', 'cobalt'].indexOf(stored.theme) !== -1) {
      data.theme = stored.theme
    }
  } catch (error) {}
})()
