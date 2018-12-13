import React from 'react'
import PropTypes from 'prop-types'

import UserPicture from 'components/User/UserPicture'
import PageListMeta from './PageListMeta'
import PagePath from './PagePath'

export default class Page extends React.Component {
  render() {
    const { page, linkTo, excludePathString, isActive, children, ...props } = this.props
    const link = linkTo === '' ? page.path : linkTo
    const active = this.props.isActive ? 'active' : ''
    return (
      <li className={`page-list-li ${active}`} {...props}>
        {children}
        <UserPicture user={page.revision.author} />
        <a className="page-list-link" href={link}>
          <PagePath page={page} excludePathString={excludePathString} />
        </a>
        <PageListMeta page={page} />
      </li>
    )
  }
}

Page.propTypes = {
  page: PropTypes.object.isRequired,
  linkTo: PropTypes.string,
  excludePathString: PropTypes.string,
  isActive: PropTypes.bool,
  children: PropTypes.element,
}

Page.defaultProps = {
  page: {},
  linkTo: '',
  excludePathString: '',
  isActive: false,
}
