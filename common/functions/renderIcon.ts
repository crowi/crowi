export default function renderIcon(path: string, classNames: string[] = [], attributes = '') {
  const className = ['mdi-svg', ...classNames].join(' ')
  const formattedAttributes = attributes && ` ${attributes}`
  return `<svg viewBox="0 0 24 24" role="presentation" class="${className}"${formattedAttributes}><path d="${path}"></path></svg>`
}
