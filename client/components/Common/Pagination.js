// @flow
import React from 'react';
import { Pagination, PaginationItem, PaginationLink } from 'reactstrap'

type Props = {
  current: number,
  count: number,
  onClick: Function,
};

export default class PaginationWrapper extends React.Component {
  props: Props;
  onClick(i) {
    const { onClick } = this.props
    return e => {
      e.preventDefault()
      if (onClick) {
        onClick(i)
      }
    }
  }

  render() {
    const { current, count } = this.props
    if (current < 1 || count < 1) {
      return null
    }
    const range = [...Array(count).keys()]
    const items = range.map((v, k) => {
      const page = k + 1
      return (
        <PaginationItem key={page} active={page === current}>
          <PaginationLink onClick={this.onClick(page)}>{page}</PaginationLink>
        </PaginationItem>
      )
    })
    return (
      <Pagination>
        <PaginationItem disabled={current === 1}>
          <PaginationLink previous onClick={this.onClick(1)} />
        </PaginationItem>
        {items}
        <PaginationItem disabled={current === count}>
          <PaginationLink next onClick={this.onClick(count)} />
        </PaginationItem>
      </Pagination>
    )
  }
}
