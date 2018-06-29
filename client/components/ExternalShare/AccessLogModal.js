import React from 'react'
import PropTypes from 'prop-types'
import moment from 'moment'
import platform from 'platform'
import { Modal, Table } from 'react-bootstrap'

const ShareInfo = (id, name, createdAt) => {
  const date = moment(createdAt).format('llll')
  return (
    <div>
      <h4>共有ID: {id}</h4>
      <dl className="share-info">
        <div>
          <dt>作成者</dt>
          <dd>
            <a href={`/user/${name}`}>{name}</a>
          </dd>
        </div>
        <div>
          <dt>作成日</dt>
          <dd>{date}</dd>
        </div>
      </dl>
    </div>
  )
}

const TableHeader = (
  <thead>
    <tr>
      <th>#</th>
      <th>ブラウザ</th>
      <th>OS</th>
      <th>IPアドレス</th>
      <th>アクセス日時</th>
    </tr>
  </thead>
)

const TableBody = ({ tracking: { userAgent, remoteAddress }, createdAt }, i) => {
  const index = i + 1
  const info = platform.parse(userAgent)
  const date = moment(createdAt).format('llll')
  return (
    <tr key={i}>
      <td>{index}</td>
      <td>{info.name}</td>
      <td>{info.os.toString()}</td>
      <td>{remoteAddress}</td>
      <td>{date}</td>
    </tr>
  )
}

const AccessLogTable = (share, i) => {
  const {
    _id: id,
    creator: { name },
    createdAt,
    accesses,
  } = share
  return (
    <div key={i}>
      {ShareInfo(id, name, createdAt)}
      <Table bordered hover>
        {TableHeader}
        <tbody>{accesses.map(TableBody)}</tbody>
      </Table>
    </div>
  )
}

export default class AccessLogModal extends React.Component {
  constructor(props) {
    super(props)

    moment.locale(navigator.userLanguage || navigator.language)

    this.state = {
      pageId: null,
      shares: [],
      pagination: {
        current: 0,
        count: 0,
        limit: 20,
      },
    }
  }

  getPage(pageId, options = {}) {
    const limit = this.state.pagination.limit
    options = { ...options, limit, page_id: pageId }
    this.props.crowi
      .apiGet('/shares.list', options)
      .then(({ share: { docs: shares, page: current, pages: count } }) => {
        const pagination = { current, count, limit }
        this.setState({ pageId, shares, pagination })
      })
      .catch(err => {
        console.log(err)
      })
  }

  componentDidMount() {
    const { pageId = null } = this.props
    if (pageId !== this.state.pageId) {
      this.getPage(pageId)
    }
  }

  componentWillReceiveProps(nextProps) {
    const { pageId = null } = nextProps
    if (pageId !== this.state.pageId) {
      this.getPage(pageId)
    }
  }

  render() {
    const { show, onHide } = this.props
    return (
      <Modal className="access-log-modal" show={show} onHide={onHide} bsSize="large">
        <Modal.Header closeButton>
          <Modal.Title id="contained-modal-title-lg">アクセスログ</Modal.Title>
        </Modal.Header>
        <Modal.Body>{this.state.shares.map(AccessLogTable)}</Modal.Body>
      </Modal>
    )
  }
}
