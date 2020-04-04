import Crowi from 'server/crowi'

export const getPath = (crowi: Crowi, path: string) => (crowi.node_env === 'development' ? `${path}.tsx` : `${path}.js`)

// FIXME: Use webpack mainfest in production
export const assetPath = (path: string) => path
