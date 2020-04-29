import React, { useContext } from 'react'
import { useTranslation } from 'react-i18next'
import Icon from 'client/components/Common/Icon'
import { userPageRoot, picture } from 'server/util/view'
import { AppContext } from './App'

const Header = () => {
  const { title, search, user, config } = useContext(AppContext)
  const [t] = useTranslation()

  return (
    <nav className="v2-crowi-header navbar navbar-expand-md" role="navigation">
      <div className="crowi-menu-main p-2">
        <div className="crowi-menu-sm" id="navigation-drawer-opener"></div>
        <a className="crowi-navbar-brand navbar-brand" href="/">
          <img alt="Crowi" src="/logo/32x32i.png" width="16" /> <span className="crowi-wiki-title">{title}</span>
        </a>

        {search?.isConfigured && (
          <div className="search-top " role="search" id="search-top">
            {/* placeholder for react */}
            <div className="search-box">
              <form className="search-form search-top-input-group">
                <div className="search-top-icon">
                  <Icon name="magnify" />
                </div>
                <input type="text" placeholder="Search ... Page title and content" className="search-top-input form-control" name="q" disabled />
              </form>
            </div>
          </div>
        )}
      </div>

      <ul className="crowi-menu-md navbar-nav p-2">
        {config?.crowi['app:confidential'] && (
          <li className="nav-item confidential">
            <a href="#">{config.crowi['app:confidential']}</a>
          </li>
        )}

        {user?.admin && (
          <li className="nav-item">
            <a href="/admin" className="nav-link">
              <Icon name="cube" /> {t('Admin')}
            </a>
          </li>
        )}

        <li className="nav-item">
          <div id="header-page-create-modal"></div>
        </li>
        <li className="nav-item nav-divider"></li>

        <li className="nav-item header-notification" id="header-notification">
          <a href="#" className="nav-link">
            <Icon name="bell" />
          </a>
        </li>
        <li className="nav-item header-user dropdown" id="login-user">
          <a href="#" id="nav-dropdown-menu" className="nav-link dropdown-toggle" data-toggle="dropdown" role="button">
            <img src={picture(user)} className="picture picture-rounded" width="25" />
          </a>

          <div className="dropdown-menu dropdown-menu-right">
            <div className="dropdown-item text-center text-muted">
              <div className="text-center header-user-picture">
                <a href={userPageRoot(user)}>
                  <img src={picture(user)} className="picture picture-rounded" />
                </a>
              </div>
              <div className="text-center header-user-container">
                <a href={userPageRoot(user)} id="link-mypage" className="nav-link">
                  <span className="header-user-name">{user?.name}</span>
                  <br />
                  <span className="header-user-username">@{user?.username}</span>
                  <br />

                  <span className="header-user-email">
                    <Icon name="email" /> {user?.email}
                  </span>
                  {user?.googleId && (
                    <span className="header-user-socialid">
                      <Icon name="google" />
                    </span>
                  )}
                  {user?.githubId && (
                    <span className="header-user-socialid">
                      <Icon name="githubBox" />
                    </span>
                  )}
                </a>
              </div>
            </div>
            <div className="dropdown-divider"></div>
            <a className="dropdown-item" href="/me">
              <Icon name="cogs" /> {t('User Settings')}
            </a>
            <a className="dropdown-item" href={`${userPageRoot(user)}/bookmarks`}>
              <Icon name="star" /> {t('Bookmarks')}
            </a>
            <a className="dropdown-item" href={`${userPageRoot(user)}/recent-create`}>
              <Icon name="pencilOutline" /> {t('Created Pages')}
            </a>
            <div className="dropdown-divider"></div>
            <a className="dropdown-item" href="/trash/">
              <Icon name="trashCanOutline" /> {t('Deleted Pages')}
            </a>
            <div className="dropdown-divider"></div>
            <a className="dropdown-item" href="/logout">
              <Icon name="logout" /> {t('Sign out')}
            </a>
          </div>
        </li>
      </ul>
    </nav>
  )
}

export default Header
