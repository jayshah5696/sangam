const comparison = document.querySelector('.comparison');
const controls = document.querySelectorAll('button[data-device]');
controls.forEach(button => button.addEventListener('click', () => {
  const device = button.dataset.device;
  controls.forEach(control => control.setAttribute('aria-pressed', String(control === button)));
  comparison.dataset.device = device;
  comparison.querySelectorAll('figure').forEach((figure, index) => {
    const source = (index === 0 ? 'before-' : 'after-') + device + '.png';
    figure.querySelector('img').src = source;
    figure.querySelector('a').href = source;
  });
}));
