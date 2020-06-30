import React from 'react'
import UserPicture from './User/UserPicture'
import Crowi from 'client/util/Crowi'
import { Backlink as BacklinkType, User } from 'client/types/crowi'

interface Props {
  crowi: Crowi
  pageId: string | null
  limit: number
  offset: number
}

interface State {
  currentOffset: number
  hasNext: boolean
  backLinks: BacklinkType[]
}

class Backlink extends React.Component<Props, State> {
  static defaultProps = {
    pageId: null,
    limit: 5,
    offset: 0,
  }

  constructor(props: Props) {
    super(props)

    this.state = {
      currentOffset: 0,
      hasNext: false,
      backLinks: [],
    }
  }

  componentDidMount() {
    this.fetchBacklinks()
  }

  fetchBacklinks() {
    this.props.crowi
      .apiGet('/backlink.list', {
        page_id: this.props.pageId,
        limit: this.props.limit + 1,
        offset: this.state.currentOffset,
      })
      .then((response) => {
        if (response.ok !== true) {
          console.log('Sorry, something went wrong.')
        } else {
          let hasNext = false
          if (response.data.length > this.props.limit) {
            hasNext = true
          }
          const appendBacklinks: BacklinkType[] = response.data.slice(0, this.props.limit)

          const backLinks = this.state.backLinks
          let i = 0
          appendBacklinks.forEach((backLink) => {
            const index = this.state.currentOffset + i
            backLinks[index] = backLink
            i++
          })

          const currentOffset = this.state.currentOffset + this.props.limit

          this.setState({
            currentOffset: currentOffset,
            hasNext: hasNext,
            backLinks: backLinks,
          })
        }
      })
      .catch((err) => {
        console.log('Failed to fetch data of Backlinks')
        // console.log(err);
      })
  }

  handleReadMore(e: React.MouseEvent<HTMLAnchorElement>) {
    e.preventDefault()
    this.fetchBacklinks()
  }

  createList(backlink: BacklinkType) {
    const path = backlink.fromPage.path
    const user = backlink.fromRevision.author

    return (
      <li className="backlink-item" key={'crowi:page:backlink:' + backlink._id}>
        <a className="backlink-link" href={path}>
          <span className="backlink-picture">
            <UserPicture user={user} />
          </span>
          <span className="backlink-path">{path}</span>
        </a>
      </li>
    )
  }

  createReadMore() {
    if (this.state.hasNext === true) {
      return (
        <p className="backlink-readmore">
          <a href="#" onClick={(e) => this.handleReadMore(e)}>
            Read More Backlinks
          </a>
        </p>
      )
    }
    return <p />
  }

  render() {
    const lists = this.state.backLinks.map((backLink) => this.createList(backLink))

    if (lists.length === 0) {
      return null
    }

    const readMore = this.createReadMore()

    return (
      <div className="page-meta-contents">
        <p className="page-meta-title">Backlinks</p>
        <ul className="backlink-list">{lists}</ul>
        {readMore}
      </div>
    )
  }
}

export default Backlink
