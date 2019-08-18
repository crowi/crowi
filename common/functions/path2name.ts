export default function path2name(path) {
  const name = path

  // /.../YYYY/MM/DD 形式のページ
  if (name.match(/^.*?([^/]+\/\d{4}\/\d{2}\/\d{2}\/?)$/)) {
    return name.replace(/^.*?([^/]+\/\d{4}\/\d{2}\/\d{2}\/?)$/, '$1')
  }

  // /.../YYYY/MM 形式のページ
  if (name.match(/^.*?([^/]+\/\d{4}\/\d{2}\/?)$/)) {
    return name.replace(/^.*?([^/]+\/\d{4}\/\d{2}\/?)$/, '$1')
  }

  // /.../YYYY 形式のページ
  if (name.match(/^.*?([^/]+\/\d{4}\/?)$/)) {
    return name.replace(/^.*?([^/]+\/\d{4}\/?)$/, '$1')
  }

  // ページの末尾を拾う
  const suffix = name.replace(/.*\/(.+\/?)$/, '$1')
  return suffix || name
}
