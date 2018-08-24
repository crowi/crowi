import EventEmitter from 'eventemitter3'

const emitter = new EventEmitter()

// TODO: Replace with Redux
if (process.env.NODE_ENV === 'development') {
  console.warn('EventEmitter is used for communication between components. Please replace this with Redux.')
}

export default emitter
