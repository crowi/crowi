import React, { FC, useState, useCallback } from 'react'
import styled, { keyframes } from 'styled-components'
import { Button } from 'reactstrap'
import { useTranslation } from 'react-i18next'
import Icon from 'client/components/Common/Icon'
import UserPicture from 'client/components/User/UserPicture'
import PageCreateModal from 'client/components/Modal/PageCreateModal'

import Crowi from 'client/util/Crowi'
import { getUserPageRoot } from 'client/services/user'

const SlideIn = keyframes`
  100% {
    transform: translateX(0%);
  }
`

const NavigationDrawerContainer = styled.div<{ isOpen: boolean }>`
  display: ${({ isOpen }) => (isOpen ? 'block' : 'none')};
  width: 300px;
  position: fixed;
  top: 3px;
  left: 0;
  bottom: 0;
  z-index: 20;
  box-shadow: 0 0 20px 5px rgba(0, 0, 0, 0.1);
  background: #fcfcfc;
  transform: translateX(-100%);
  animation: ${SlideIn} 0.2s forwards;
`

const StyledNavigationDrawer = styled.div`
  height: 100%;
  overflow-y: scroll;
`

const Brand = styled.a`
  display: flex;
  align-items: center;
`

const Logo = styled.img`
  margin-right: 8px;
`

const UserProfile = styled.div`
  padding: 1em;
`

const BellIcon = styled(Icon)`
  margin-right: 8px;
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

const Backdrop = styled.div<{ isOpen: boolean }>`
  display: ${({ isOpen }) => (isOpen ? 'block' : 'none')};
  height: 100vh;
  width: 100vw;
  transition: background-color 0.2s;
  background-color: rgba(0, 0, 0, 0.1);
  position: absolute;
  top: 0;
  left: 0;
  z-index: 20;
`

interface Props {
  crowi: Crowi
  isOpen?: boolean
  handleClose?(): void
}

const NavigationDrawer: FC<Props> = ({ crowi, isOpen = false, handleClose }) => {
  const { title = 'Crowi' } = crowi.getContext() || {}
  const user = crowi.getUser()
  const [t] = useTranslation()

  const [isModalOpen, setIsModalOpen] = useState(false)

  const toggleModal = useCallback(() => {
    setIsModalOpen(!isModalOpen)
  }, [setIsModalOpen, isModalOpen])

  return (
    <>
      <Backdrop isOpen={isOpen} onClick={handleClose} />
      <NavigationDrawerContainer isOpen={isOpen} handleClose={handleClose}>
        <StyledNavigationDrawer>
          <nav className="navbar" role="navigation">
            <Brand className="navbar-brand" href="/">
              <Logo alt="Crowi" src="/logo/32x32i.png" width="16" />
              <span className="crowi-wiki-title">{title}</span>
            </Brand>
          </nav>

          <UserProfile>
            <div className="d-flex justify-content-between">
              <div>
                <a href={getUserPageRoot(user)}>
                  <UserPicture user={user} size="lg" />
                </a>
              </div>
              <div>
                <a href="/me/notifications">
                  <BellIcon name="bell" />
                </a>
                <Button outline color="secondary" onClick={toggleModal}>
                  <Icon name="pencilOutline" /> {t('New')}
                </Button>
              </div>
            </div>

            <Names>
              <a href={getUserPageRoot(user)}>
                <Name>{user.name}</Name>
                <br />
                <Username>@{user.username}</Username>
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
                <Icon name="pencilOutline" /> {t('Created Pages')}
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
      <PageCreateModal crowi={crowi} isOpen={isModalOpen} toggle={toggleModal} />
    </>
  )
}

export default NavigationDrawer
