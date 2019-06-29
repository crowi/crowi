const swig = require('swig')

module.exports = (crowi, app) => {
  return (req, res, next) => {
    swig.setFilter('path2name', function(string) {
      const name = string

      // /.../YYYY/MM/DD 形式のページ
      if (name.match(/^.*?([^/]+\/\d{4}\/\d{2}\/\d{2})\/?$/)) {
        return name.replace(/^.*?([^/]+\/\d{4}\/\d{2}\/\d{2})\/?$/, '$1')
      }

      // /.../YYYY/MM 形式のページ
      if (name.match(/^.*?([^/]+\/\d{4}\/\d{2})\/?$/)) {
        return name.replace(/^.*?([^/]+\/\d{4}\/\d{2})\/?$/, '$1')
      }

      // /.../YYYY 形式のページ
      if (name.match(/^.*?([^/]+\/\d{4})\/?$/)) {
        return name.replace(/^.*?([^/]+\/\d{4})\/?$/, '$1')
      }

      // ページの末尾を拾う
      const suffix = name.replace(/.+\/(.+)?$/, '$1')
      return suffix || name
    })

    swig.setFilter('normalizeDateInPath', function(path) {
      var patterns = [
        [/20(\d{2})(\d{2})(\d{2})(.+)/g, '20$1/$2/$3/$4'],
        [/20(\d{2})(\d{2})(\d{2})/g, '20$1/$2/$3'],
        [/20(\d{2})(\d{2})(.+)/g, '20$1/$2/$3'],
        [/20(\d{2})(\d{2})/g, '20$1/$2'],
        [/20(\d{2})_(\d{1,2})_(\d{1,2})_?(.+)/g, '20$1/$2/$3/$4'],
        [/20(\d{2})_(\d{1,2})_(\d{1,2})/g, '20$1/$2/$3'],
        [/20(\d{2})_(\d{1,2})_?(.+)/g, '20$1/$2/$3'],
        [/20(\d{2})_(\d{1,2})/g, '20$1/$2'],
      ]

      for (var i = 0; i < patterns.length; i++) {
        var mat = patterns[i][0]
        var rep = patterns[i][1]
        if (path.match(mat)) {
          return path.replace(mat, rep)
        }
      }

      return path
    })

    swig.setFilter('datetz', function(input, format) {
      // timezone
      var swigFilters = require('swig/lib/filters')
      return swigFilters.date(input, format, app.get('tzoffset'))
    })

    swig.setFilter('nl2br', function(string) {
      return string.replace(/\n/g, '<br>')
    })

    swig.setFilter('insertSpaceToEachSlashes', function(string) {
      if (string == '/') {
        return string
      }

      return string.replace(/\//g, ' / ')
    })

    swig.setFilter('removeLastSlash', function(string) {
      if (string == '/') {
        return string
      }

      return string.substr(0, string.length - 1)
    })

    swig.setFilter('presentation', function(string) {
      // 手抜き
      return string.replace(/[\n]+#/g, '\n\n\n#').replace(/\s(https?.+(jpe?g|png|gif))\s/, '\n\n\n![]($1)\n\n\n')
    })

    swig.setFilter('picture', function(user) {
      if (!user) {
        return ''
      }

      if (user.image && user.image != '/images/userpicture.png') {
        return user.image
      } else {
        return '/images/userpicture.png'
      }
    })

    next()
  }
}
