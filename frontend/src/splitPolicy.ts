export const minimumHorizontalGroupWidth = 420
export const minimumVerticalGroupHeight = 300

export function canSplitActiveGroup(direction: 'horizontal' | 'vertical') {
  const activeGroup = document.querySelector<HTMLElement>('.editor-group.active')
  if (!activeGroup) return true
  const available = direction === 'horizontal' ? activeGroup.clientWidth : activeGroup.clientHeight
  const minimum = direction === 'horizontal' ? minimumHorizontalGroupWidth : minimumVerticalGroupHeight
  return available >= minimum * 2 + 4
}

export function preferredSplitDirection(): 'horizontal' | 'vertical' {
  return canSplitActiveGroup('horizontal') ? 'horizontal' : 'vertical'
}
