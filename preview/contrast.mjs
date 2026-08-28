function L(hex) {
  const h = hex.replace('#', '')
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
  const f = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
function ratio(a, b) {
  const la = L(a), lb = L(b)
  return ((Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)).toFixed(2)
}
const pairs = [
  ['dark text on bg', '#e9ecf2', '#0f1115'],
  ['dark muted on bg', '#9aa4b5', '#0f1115'],
  ['dark accent on bg', '#6ea3ff', '#0f1115'],
  ['dark on-accent on accent', '#0b1020', '#6ea3ff'],
  ['light text on white', '#18202c', '#ffffff'],
  ['light muted on white', '#556072', '#ffffff'],
  ['light accent on white', '#2f6bdc', '#ffffff'],
  ['light accent on panel-2', '#2860cf', '#ebedf3'],
  ['light on-accent on accent', '#ffffff', '#2860cf'],
  ['dark err on err-surface', '#ff6f6f', '#2a2024'],
  ['light err on err-surface', '#c53939', '#f6e4e4'],
  ['dark ok on bg', '#43c9a3', '#0f1115'],
  ['light ok on white', '#0a865e', '#ffffff'],
  ['dark faint on panel', '#687183', '#161a21'],
]
for (const [name, a, b] of pairs) {
  const r = parseFloat(ratio(a, b))
  const pass = r >= 4.5 ? 'PASS' : r >= 3 ? 'AA-large' : 'FAIL'
  console.log(`${ratio(a, b).padStart(7)}  ${pass.padEnd(8)} ${name}`)
}
