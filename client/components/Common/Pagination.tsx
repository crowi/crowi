import React from 'react'
import { Pagination, PaginationItem, PaginationLink } from 'reactstrap'

const PAGER_VIEW_COUNT = 5

interface Props {
  onClick: Function
  current: number
  count: number
}

const createPages = function (current: number, count: number) {
  let pageSize = PAGER_VIEW_COUNT
  let start = current - Math.floor(PAGER_VIEW_COUNT / 2)

  if (count <= PAGER_VIEW_COUNT) {
    pageSize = count
    start = 1
  } else if (start <= 1) {
    start = 1
    if (count < PAGER_VIEW_COUNT) {
      pageSize = count
    }
  } else if (start > 1) {
    if (start > count - PAGER_VIEW_COUNT) {
      start = count - PAGER_VIEW_COUNT + 1
    }
  }

  return [...Array(pageSize)].map((_, i) => i + start)
}

const PaginationWrapper: React.FC<Props> = (props) => {
  const { current, count } = props

  const onClick = (i?: number | null) => {
    const { onClick } = props
    return (e: React.MouseEvent<HTMLElement>) => {
      e.preventDefault()
      onClick(i)
    }
  }

  if (current < 1 || count < 1) {
    return null
  }

  const pages: number[] = createPages(current, count)

  return (
    <Pagination>
      {current !== 1 && (
        <PaginationItem>
          <PaginationLink first onClick={onClick(1)} />
        </PaginationItem>
      )}
      {current !== 1 && (
        <PaginationItem>
          <PaginationLink previous onClick={onClick(current - 1)} />
        </PaginationItem>
      )}
      {count > PAGER_VIEW_COUNT && current - Math.floor(PAGER_VIEW_COUNT / 2) > 1 && (
        <PaginationItem>
          <PaginationLink href="#">...</PaginationLink>
        </PaginationItem>
      )}
      {pages.map((p) => {
        return (
          <PaginationItem key={p} active={p === current}>
            <PaginationLink onClick={onClick(p)}>{p}</PaginationLink>
          </PaginationItem>
        )
      })}
      {count > PAGER_VIEW_COUNT && current + Math.floor(PAGER_VIEW_COUNT / 2) < count && (
        <PaginationItem>
          <PaginationLink href="#">...</PaginationLink>
        </PaginationItem>
      )}
      {current !== count && (
        <PaginationItem>
          <PaginationLink next onClick={onClick(current + 1)} />
        </PaginationItem>
      )}
      {current !== count && (
        <PaginationItem>
          <PaginationLink last onClick={onClick(count)} />
        </PaginationItem>
      )}
    </Pagination>
  )
}

export default PaginationWrapper
