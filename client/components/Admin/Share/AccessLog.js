import React from 'react'
import PropTypes from 'prop-types'
import moment from 'moment'
import platform from 'platform'
import { Table } from 'react-bootstrap'
import Pagination from 'components/Common/Pagination'

export default class AccessLog extends React.Component {
  constructor(props) {
    super(props)

    moment.locale(navigator.userLanguage || navigator.language)

    this.state = {
      accesses: [],
      pagination: {
        current: 0,
        count: 0,
        limit: 20,
      },
    }

    this.getPage = this.getPage.bind(this)
    this.movePage = this.movePage.bind(this)
    this.renderTableBody = this.renderTableBody.bind(this)
  }

  getPage(options = {}) {
    const limit = this.state.pagination.limit
    options = { ...options, limit }
    this.props.crowi
      .apiGet('/accesses.list', options)
      .then(({ access: { docs: accesses, page: current, pages: count } }) => {
        const pagination = { current, count, limit }
        this.setState({ accesses, pagination })
      })
      .catch(err => {
        console.log(err)
      })
  }

  movePage(i) {
    if (i !== this.state.pagination.current) {
      this.getPage({ page: i })
    }
  }

  componentDidMount() {
    this.getPage()
  }

  renderTableBody() {
    const { current, limit } = this.state.pagination
    const start = (current - 1) * limit + 1
    return (
      <tbody>
        {this.state.accesses.map(({ share, tracking, createdAt }, i) => {
          const index = start + i
          const {
            page: { path },
          } = share
          const { userAgent, remoteAddress } = tracking
          const info = platform.parse(userAgent)
          const date = moment(createdAt).format('L')
          return (
            <tr key={index}>
              <td>{index}</td>
              <td>{path}</td>
              <td>{info.name}</td>
              <td>{info.os.toString()}</td>
              <td>{remoteAddress}</td>
              <td>{date}</td>
            </tr>
          )
        })}
      </tbody>
    )
  }

  render() {
    const {
      pagination: { current, count },
    } = this.state
    return (
      <div>
        <Table bordered hover condensed>
          <thead>
            <tr>
              <th>#</th>
              <th>ページ名</th>
              <th>ブラウザ</th>
              <th>OS</th>
              <th>IPアドレス</th>
              <th>アクセス日時</th>
            </tr>
          </thead>
          {this.renderTableBody()}
        </Table>
        <Pagination current={current} count={count} onClick={this.movePage} />
      </div>
    )
  }
}

AccessLog.propTypes = {
  pageId: PropTypes.string,
  crowi: PropTypes.object.isRequired,
}
