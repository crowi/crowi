import React, { FC, createContext } from 'react'
import i18next from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { AppContext as AppContextType } from 'server/types/appContext'

export interface Props {
  i18n: i18next.i18n
  context: AppContextType
}

export const AppContext = createContext<Partial<AppContextType>>({})

const App: FC<Props> = ({ i18n, context, children }) => {
  return (
    <I18nextProvider i18n={i18n}>
      <AppContext.Provider value={context}>{children}</AppContext.Provider>
    </I18nextProvider>
  )
}

export default App
