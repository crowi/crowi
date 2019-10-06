import React, { useState } from 'react'
import HelpPortalModal from './HelpPortalModal'

export default { title: 'Help/HelpPortalModal/HelpPortalModal' }

export const Default = () => {
  const [el, setEl] = useState<HTMLElement | null>(null)

  return (
    <div>
      <a href="javascript:void(0)" ref={el => setEl(el)}>
        Open Modal
      </a>
      <HelpPortalModal el={el} />
    </div>
  )
}
