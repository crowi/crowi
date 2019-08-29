import React from 'react'
import { withTranslation, WithTranslation } from 'react-i18next'
import Icon from 'components/Common/Icon'
import SearchTypeNav from 'components/SearchPage/SearchTypeNav/SearchTypeNav'

interface Props extends WithTranslation {
  keyword: string
  type: string
  total: number | undefined
  changeType: Function
  searching: boolean
}

export interface SearchType {
  key: string
  icon: JSX.Element
  name: string
}

class SearchToolbar extends React.Component<Props> {
  static defaultProps = {
    keyword: '',
    type: '',
    searching: false,
    total: 0,
  }

  searchTypes: SearchType[]

  constructor(props: Props) {
    super(props)

    const { t } = this.props
    this.searchTypes = [
      {
        key: '',
        icon: <Icon name="grid" />,
        name: t('page_types.all'),
      },
      {
        key: 'portal',
        icon: <Icon name="fileDocumentBoxMultipleOutline" />,
        name: t('page_types.portal'),
      },
      {
        key: 'public',
        icon: <Icon name="fileDocumentBoxOutline" />,
        name: t('page_types.public'),
      },
      {
        key: 'user',
        icon: <Icon name="account" />,
        name: t('page_types.user'),
      },
    ]

    this.getActiveType = this.getActiveType.bind(this)
  }

  getActiveType() {
    const defaultType = this.searchTypes[0]
    const searchTypes: { [key: string]: SearchType } = this.searchTypes.reduce((object, { key, icon, name }) => ({ ...object, [key]: { key, icon, name } }), {})
    const { type: searchType } = this.props
    return searchType in searchTypes ? searchTypes[searchType] : defaultType
  }

  render() {
    const { t, changeType } = this.props
    const activeType = this.getActiveType()
    return (
      <div className="search-toolbar row">
        <div className="search-meta col-md-4">
          <h3 className="search-keyword">{this.props.keyword}</h3>
          <small className="text-muted">
            {(this.props.searching && <Icon name="loading" spin />) || t('search.toolbar.results', { value: this.props.total })}
          </small>
        </div>
        <nav className="search-navbar col-md-8">
          <SearchTypeNav searchTypes={this.searchTypes} activeType={activeType} changeType={changeType} />
        </nav>
      </div>
    )
  }
}

export default withTranslation()(SearchToolbar)
