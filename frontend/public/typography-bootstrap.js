; (function () {
  try {
    var stored = JSON.parse(localStorage.getItem('sangam.workspace-preferences.v1') || '{}')
    var root = document.documentElement.dataset
    if (['system', 'inter', 'plex', 'serif'].indexOf(stored.uiFont) !== -1) root.uiFont = stored.uiFont
    if (['system', 'sfmono', 'jetbrains', 'fira'].indexOf(stored.monoFont) !== -1)
      root.monoFont = stored.monoFont
    if (['compact', 'default', 'comfortable'].indexOf(stored.uiDensity) !== -1)
      root.uiDensity = stored.uiDensity
    if (['small', 'default', 'large'].indexOf(stored.editorSize) !== -1)
      root.editorSize = stored.editorSize
  } catch (error) {}
})()
