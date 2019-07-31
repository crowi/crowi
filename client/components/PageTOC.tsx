import React from 'react'
import UserList from './SeenUserList/UserList'
import Crowi from 'client/util/Crowi'
import { User } from 'client/types/crowi'
import Icon from './Common/Icon'

interface Props {
  crowi: Crowi
}

interface State {
  toc: string[]
}

export default class PageTOC extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)

    this.state = {
      toc: [],
    }
  }

  componentDidMount() {}

  generateToc() {
    return {
      head1: 'こんにちは',
      head2: 'おやすみなさい',
    }
  }

  render() {
    const tocList = this.generateToc()
    return <div className="page-toc-list">{tocList}</div>
  }
}
