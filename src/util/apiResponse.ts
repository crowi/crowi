export default {
  error(err?, info = {}) {
    const result: {
      ok: boolean
      info: any
      error?: any
    } = {
      ok: false,
      info,
    }

    if (err instanceof Error) {
      result.error = err.toString()
    } else {
      result.error = err
    }

    return result
  },
  success(data?) {
    const result = data || {}

    result.ok = true
    return result
  },
}
