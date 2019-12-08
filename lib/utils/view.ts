// Static functions related to view used by swig (functions and filters) and react

export const parentPath = (path: string) => {
  if (path === '/' || path.match(/.+\/$/)) {
    return path
  }

  return path + '/'
}

export const isUserPageList = path => path.match(/^\/user\/[^/]+\/$/) || path.match(/^\/user\/$/)

export const isUserPage = (path: string) => path.match(/^\/user\/[^/]+$/)

export const isTopPage = (path: string) => path === '/'

export const isTrashPage = (path: string) => path.match(/^\/trash\/.*/)

export const userPageRoot = user => {
  if (!user || !user.username) {
    return ''
  }
  return '/user/' + user.username
}

export const picture = user => {
  if (!user) {
    return ''
  }

  if (user.image && user.image != '/images/userpicture.png') {
    return user.image
  } else {
    return '/images/userpicture.png'
  }
}
