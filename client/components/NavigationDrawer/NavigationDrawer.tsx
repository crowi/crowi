import React, { FC } from 'react'
import { useTranslation } from 'react-i18next'
import Icon from 'client/components/Common/Icon'

import Crowi from 'client/util/Crowi'
import { getUserPicture, getUserPageRoot } from 'client/services/user'

interface Props {
  crowi: Crowi
}

const NavigationDrawer: FC<Props> = ({ crowi }) => {
  const { title = 'Crowi' } = crowi.getConfig().crowi || {}
  const user = crowi.getUser()
  const [t] = useTranslation()

  return (
    <div className="v2-crowi-global-menu-container" id="crowi-global-menu">
      <div className="v2-crowi-global-menu">
        <nav className="navbar" role="navigation">
          <a className="navbar-brand" href="/">
            <img alt="Crowi" src="/logo/32x32i.png" width="16" />
            <span className="crowi-wiki-title">{title}</span>
          </a>
        </nav>

        <div className="menu-user-profile">
          <div className="d-flex  justify-content-between">
            <div className="menu-user-picture">
              <a href={getUserPageRoot(user)}>
                <img src={getUserPicture(user)} className="picture picture-rounded" />
              </a>
            </div>
            <div>
              <a href="/me/notifications">
                <Icon name="bell" />
              </a>
              <button className="btn btn-outline-secondary create-page-button" data-target="#create-page" data-toggle="modal">
                <Icon name="pencilOutline" /> {t('New')}
              </button>
            </div>
          </div>

          <div className="menu-user-names">
            <a href={getUserPageRoot(user)}>
              <span className="menu-user-name">{user?.name}</span>
              <br />
              <span className="menu-user-username">@{user?.username}</span>
            </a>
          </div>
        </div>

        <ul className="menu-list">
          <li>
            <a href="/me">
              <Icon name="cogs" /> {t('User Settings')}
            </a>
          </li>
          <li>
            <a href={`${getUserPageRoot(user)}/bookmarks`}>
              <Icon name="star" /> {t('Bookmarks')}
            </a>
          </li>
          <li>
            <a href={`${getUserPageRoot(user)}/recent-create`}>
              <Icon name="pencilOutline" /> {t('Created pages')}
            </a>
          </li>
          <li className="divider"></li>
          <li>
            <a href="/trash/">
              <Icon name="trashCanOutline" /> {t('Deleted Pages')}
            </a>
          </li>
          <li className="divider"></li>
          <li>
            <a href="/logout">
              <Icon name="logout" /> {t('Sign out')}
            </a>
          </li>
        </ul>
      </div>
    </div>
  )
}

export default NavigationDrawer
