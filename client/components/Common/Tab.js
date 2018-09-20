// @flow
import React from 'react';
import { Nav, NavItem, NavLink, TabContent, TabPane } from 'reactstrap'

type Props = {
  children: number | string | React.Element | Array<any>,
  active?: number,
};

export default class Tab extends React.Component {
  constructor(props: Props) {
    super(props)

    const { active } = props
    this.state = { active }
  }

  props: Props;

  toggle(tab) {
    return () => {
      if (this.state.active !== tab) {
        this.setState({ active: tab })
      }
    }
  }

  getTabTitles() {
    return React.Children.map(this.props.children, child => {
      const { title = '' } = child.props
      return React.isValidElement(child) ? title : false
    }).filter(title => title !== false)
  }

  renderNavItems() {
    const titles = this.getTabTitles()
    const { active } = this.state
    return titles.map((title, i) => (
      <NavItem key={i + 1}>
        <NavLink active={active === i + 1} onClick={this.toggle(i + 1)}>
          {title}
        </NavLink>
      </NavItem>
    ))
  }

  renderTabPanes() {
    return React.Children.map(this.props.children, (child, i) => {
      if (React.isValidElement(child)) {
        return <TabPane tabId={i + 1}>{child}</TabPane>
      }
    })
  }

  render() {
    const { active: _, ...props } = this.props
    const { active } = this.state
    return (
      <div {...props}>
        <Nav tabs>{this.renderNavItems()}</Nav>
        <TabContent activeTab={active}>{this.renderTabPanes()}</TabContent>
      </div>
    )
  }
}

Tab.defaultProps = {
  active: 1,
}
