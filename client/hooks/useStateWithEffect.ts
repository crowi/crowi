import { useState, useEffect, Dispatch, SetStateAction } from 'react'

export default function useStateWithEffect<S>(initialState: S | (() => S)): [S, Dispatch<SetStateAction<S>>] {
  const [state, setState] = useState(initialState)

  useEffect(() => {
    setState(initialState)
  }, [initialState])

  return [state, setState]
}
