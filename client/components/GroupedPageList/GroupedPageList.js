import React from 'react'
import PropTypes from 'prop-types'
import { translate } from 'react-i18next'

import GroupedPageListTitle from './GroupedPageListTitle'
import ListView from 'components/PageList/ListView'

class GroupedPageList extends React.Component {
  static propTypes = {
    pages: PropTypes.objectOf(PropTypes.array).isRequired,
    title: PropTypes.oneOfType([PropTypes.element, PropTypes.func]),
    list: PropTypes.oneOfType([PropTypes.element, PropTypes.func]),
  }

  renderTitle(type, title, icon) {
    const { title: titleComponent } = this.props
    if (titleComponent) {
      if (React.isValidElement(titleComponent)) {
        return React.cloneElement(titleComponent, { type, title, icon })
      }
      return titleComponent(type, title, icon)
    }
    return <GroupedPageListTitle icon={icon} title={title} />
  }

  renderList(type, pages) {
    const { list: listComponent } = this.props
    if (listComponent) {
      if (React.isValidElement(listComponent)) {
        return React.cloneElement(listComponent, { type, pages })
      }
      return listComponent(type, pages)
    }
    return <ListView pages={pages} />
  }

  render() {
    const { t, pages } = this.props
    const groups = [
      {
        type: 'portal',
        title: t('page_types.portal'),
        icon: 'circle',
        pages: pages.portal || [],
      },
      {
        type: 'public',
        title: t('page_types.public'),
        icon: 'file',
        pages: pages.public || [],
      },
      {
        type: 'user',
        title: t('page_types.user'),
        icon: 'user',
        pages: pages.user || [],
      },
    ]
    return (
      <div>
        {groups.map(
          ({ type, title, icon, pages }) =>
            pages.length > 0 && (
              <div key={type} className="grouped-page-list">
                {this.renderTitle(type, title, icon)}
                {this.renderList(type, pages)}
              </div>
            ),
        )}
      </div>
    )
  }
}

export default translate()(GroupedPageList)
