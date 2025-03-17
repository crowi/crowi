import { Express, Request, Response } from 'express'
import Crowi from 'src/crowi'
import swig from 'swig'
import swigFilters from 'swig/lib/filters'
import path2name from 'common/functions/path2name'
import { picture } from 'src/util/view'

export default (crowi: Crowi, app: Express) => {
  return (req: Request, res: Response, next) => {
    swig.setFilter('path2name', function (path) {
      return path2name(path)
    })

    swig.setFilter('normalizeDateInPath', function (path) {
      const patterns = [
        [/20(\d{2})(\d{2})(\d{2})(.+)/g, '20$1/$2/$3/$4'],
        [/20(\d{2})(\d{2})(\d{2})/g, '20$1/$2/$3'],
        [/20(\d{2})(\d{2})(.+)/g, '20$1/$2/$3'],
        [/20(\d{2})(\d{2})/g, '20$1/$2'],
        [/20(\d{2})_(\d{1,2})_(\d{1,2})_?(.+)/g, '20$1/$2/$3/$4'],
        [/20(\d{2})_(\d{1,2})_(\d{1,2})/g, '20$1/$2/$3'],
        [/20(\d{2})_(\d{1,2})_?(.+)/g, '20$1/$2/$3'],
        [/20(\d{2})_(\d{1,2})/g, '20$1/$2'],
      ]

      for (let i = 0; i < patterns.length; i++) {
        const mat = patterns[i][0]
        const rep = patterns[i][1]
        if (path.match(mat)) {
          return path.replace(mat, rep)
        }
      }

      return path
    })

    swig.setFilter('datetz', function (input, format) {
      // timezone
      return swigFilters.date(input, format, app.get('tzoffset'))
    })

    swig.setFilter('nl2br', function (string) {
      return string.replace(/\n/g, '<br>')
    })

    swig.setFilter('insertSpaceToEachSlashes', function (string) {
      if (string == '/') {
        return string
      }

      return string.replace(/\//g, ' / ')
    })

    swig.setFilter('removeLastSlash', function (string) {
      if (string == '/') {
        return string
      }

      return string.substr(0, string.length - 1)
    })

    swig.setFilter('picture', picture)

    next()
  }
}
