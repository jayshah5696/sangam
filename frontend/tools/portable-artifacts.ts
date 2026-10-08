// Restrict capture destinations, not home paths used as test data.
const homePath = ':matches(Literal[value=/^\\x2f(home|Users)\\x2f/], TemplateElement[value.raw=/^\\x2f(home|Users)\\x2f/])'
const message = 'Use testInfo.outputPath() or a configurable artifact directory instead of a developer home path.'

export const portableArtifactRestrictions = [
  {
    selector: `VariableDeclarator[id.name=/(artifact|evidence|screenshot|output).*(dir|path)/i] ${homePath}`,
    message,
  },
  {
    selector: `CallExpression[callee.property.name='screenshot'] Property[key.name='path'] ${homePath}`,
    message,
  },
]
