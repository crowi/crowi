export interface Attachment {
  _id: string
  page: Page
  creator: User
  filePath: string
  fileName: string
  originalName: string
  fileFormat: string
  fileSize: number
  createdAt: string
  url: string
}

export interface Backlink {
  _id: string
  page: Page
  fromPage: Page
  fromRevision: Revision
  updatedAt: string
}

export interface Notification {
  _id: string
  user: string
  targetModel: 'Page'
  target: Page
  action: 'COMMENT' | 'LIKE'
  status: string
  actionUsers: User[]
  createdAt: string
}

export interface Page {
  _id: string
  path: string
  revision: Revision
  redirectTo: string
  status: string
  creator: User
  lastUpdateUser: User
  liker: User[]
  seenUsers: User[]
  commentCount: number
  bookmarkCount?: number
  createdAt: Date
  updatedAt: Date
}

export interface Revision {
  _id: string
  path: string
  body: string
  format: string
  author: User
  createdAt: string
}

export interface Share {
  uuid: string
  page: Page | null
  status: string
  creator: User
  secretKeyword: string
  accesses: ShareAccess[]
  createdAt: string
  updatedAt: string
}

export interface ShareAccess {
  share: Share
  tracking: Tracking
  createdAt: string
  lastAccessedAt: string
}

export interface Tracking {
  userAgent: string
  remoteAddress: string
  createdAt: string
}

export interface User {
  _id: string
  image: string
  name: string
  username: string
}

export interface Comment {
  _id: string
  page: string
  creator: string
  revision: string
  comment: string
  commentPosition: number
  createdAt: string
}
