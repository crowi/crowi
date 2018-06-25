import React from 'react'
import PropTypes from 'prop-types'
import moment from 'moment'
import platform from 'platform'
import { Table } from 'react-bootstrap'

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

    this.movePage = this.movePage.bind(this)
    this.renderTableBody = this.renderTableBody.bind(this)
    this.renderPagination = this.renderPagination.bind(this)
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

  componentDidMount() {
    this.getPage()
  }

  movePage(i) {
    return e => {
      e.preventDefault()
      if (i !== this.state.pagination.current) {
        this.getPage({ page: i })
      }
    }
  }

  renderTableBody() {
    const { current, limit } = this.state.pagination
    const start = (current - 1) * limit + 1
    return (
      <tbody>
        {this.state.accesses.map(({ tracking, createdAt }, i) => {
          const index = start + i
          const { userAgent, remoteAddress } = tracking
          const info = platform.parse(userAgent)
          console.log(info)
          const date = moment(createdAt).format('L')
          return (
            <tr key={index}>
              <td>{index}</td>
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

  renderPagination() {
    const { current, count } = this.state.pagination
    const range = [...Array(count).keys()]
    const items = range.map((v, k) => {
      const page = k + 1
      const className = page === current ? 'active' : ''
      return (
        <li key={page} className={className}>
          <a onClick={this.movePage(page)}>{page}</a>
        </li>
      )
    })
    return (
      <nav>
        <ul className="pagination">
          <li className={current === 1 ? 'disabled' : ''}>
            <a onClick={this.movePage(1)}>&laquo;</a>
          </li>
          {items}
          <li className={current === count ? 'disabled' : ''}>
            <a onClick={this.movePage(count)}>&raquo;</a>
          </li>
        </ul>
      </nav>
    )
  }

  render() {
    return (
      <div>
        <Table bordered hover>
          <thead>
            <tr>
              <th>#</th>
              <th>ブラウザ</th>
              <th>OS</th>
              <th>IPアドレス</th>
              <th>アクセス日時</th>
            </tr>
          </thead>
          {this.renderTableBody()}
        </Table>
        {this.renderPagination()}
      </div>
    )
  }
}
