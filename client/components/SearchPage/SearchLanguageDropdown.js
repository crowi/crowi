import React from 'react'
import PropTypes from 'prop-types'
import { translate } from 'react-i18next'
import { Dropdown, DropdownToggle, DropdownMenu, DropdownItem } from 'reactstrap'

class SearchLanguageDropdown extends React.Component {
  constructor(props) {
    super(props)

    const { language: current, crowi } = this.props
    const languages = crowi.getLanguages()
    this.state = {
      open: false,
      current: current || 'all',
      languages,
    }

    this.toggle = this.toggle.bind(this)
    this.onClick = this.onClick.bind(this)
  }

  toggle() {
    this.setState({
      open: !this.state.open,
    })
  }

  onClick(language) {
    const { changeLanguage } = this.props
    return () => {
      if (changeLanguage) {
        this.setState({ current: language })
        changeLanguage(language === 'all' ? '' : language)
      }
    }
  }

  getOptions() {
    const { current, languages } = this.state
    const all = current !== 'all' ? ['all'] : []
    const selectable = languages.filter(language => language !== current)
    return [...all, ...selectable]
  }

  renderDropdownItem(language) {
    const { t } = this.props
    return (
      <DropdownItem key={language} onClick={this.onClick(language)}>
        {t(`languages.${language}`)}
      </DropdownItem>
    )
  }

  render() {
    const { open, current } = this.state
    const { t } = this.props
    return (
      <Dropdown className="search-language-dropdown" isOpen={open} toggle={this.toggle}>
        <DropdownToggle tag="div" caret>
          {t(`languages.${current}`)}
        </DropdownToggle>
        <DropdownMenu right>{this.getOptions().map(language => this.renderDropdownItem(language))}</DropdownMenu>
      </Dropdown>
    )
  }
}

SearchLanguageDropdown.propTypes = {
  language: PropTypes.string,
  changeLanguage: PropTypes.func.isRequired,
  t: PropTypes.func.isRequired,
  crowi: PropTypes.object.isRequired,
}
SearchLanguageDropdown.defaultProps = {}

export default translate()(SearchLanguageDropdown)
