import React, { FC } from 'react'
import styled, { keyframes } from 'styled-components'
import { useTranslation } from 'react-i18next'
import Icon from 'client/components/Common/Icon'
import UserPicture from 'client/components/User/UserPicture'

import Crowi from 'client/util/Crowi'
import { getUserPageRoot } from 'client/services/user'

const SlideIn = keyframes`
  100% {
    transform: translateX(0%);
  }
`

const NavigationDrawerContainer = styled.div`
  display: block;
  width: 300px;
  position: fixed;
  top: 3px;
  bottom: 0;
  z-index: 1200;
  box-shadow: 0 0 20px 5px rgba(0, 0, 0, 0.1);
  background: #fcfcfc;
  transform: translateX(-100%);
  animation: ${SlideIn} 0.2s forwards;
`

const StyledNavigationDrawer = styled.div`
  height: 100%;
  overflow-y: scroll;
`

const UserProfile = styled.div`
  padding: 1em;
`

const Names = styled.div`
  padding-top: 1em;
  padding-bottom: 1em;
`

const Name = styled.span`
  font-size: 1.2em;
  font-weight: 600;
`

const Username = styled.span`
  font-size: 0.9em;
  color: #777;
`

const Menu = styled.ul`
  position: relative;
  width: calc(100% - 1em);
  padding-left: 1em;
`

const MenuItem = styled.li`
  list-style: none;
  padding-bottom: 0.4em;
`

const Divider = styled(MenuItem)`
  border-bottom: solid 1px #f0f0f0;
  margin-bottom: 0.4em;
`

interface Props {
  crowi: Crowi
}

const NavigationDrawer: FC<Props> = ({ crowi }) => {
  const { title = 'Crowi' } = crowi.getConfig().crowi || {}
  const user = crowi.getUser()
  const [t] = useTranslation()

  return (
    <NavigationDrawerContainer className="v2-crowi-global-menu-container" id="crowi-global-menu">
      <StyledNavigationDrawer>
        <nav className="navbar" role="navigation">
          <a className="navbar-brand" href="/">
            <img alt="Crowi" src="/logo/32x32i.png" width="16" />
            <span className="crowi-wiki-title">{title}</span>
          </a>
        </nav>

        <UserProfile>
          <div className="d-flex justify-content-between">
            <div className="menu-user-picture">
              <a href={getUserPageRoot(user)}>
                <UserPicture user={user} size="lg" />
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

          <Names>
            <a href={getUserPageRoot(user)}>
              <Name>{user?.name}</Name>
              <br />
              <Username>@{user?.username}</Username>
            </a>
          </Names>
        </UserProfile>

        <Menu>
          <MenuItem>
            <a href="/me">
              <Icon name="cogs" /> {t('User Settings')}
            </a>
          </MenuItem>
          <MenuItem>
            <a href={`${getUserPageRoot(user)}/bookmarks`}>
              <Icon name="star" /> {t('Bookmarks')}
            </a>
          </MenuItem>
          <MenuItem>
            <a href={`${getUserPageRoot(user)}/recent-create`}>
              <Icon name="pencilOutline" /> {t('Created pages')}
            </a>
          </MenuItem>
          <Divider />
          <MenuItem>
            <a href="/trash/">
              <Icon name="trashCanOutline" /> {t('Deleted Pages')}
            </a>
          </MenuItem>
          <Divider />
          <MenuItem>
            <a href="/logout">
              <Icon name="logout" /> {t('Sign out')}
            </a>
          </MenuItem>
        </Menu>
      </StyledNavigationDrawer>
    </NavigationDrawerContainer>
  )
}

export default NavigationDrawer
