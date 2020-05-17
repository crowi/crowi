import React from 'react'
import { Pagination, PaginationItem, PaginationLink } from 'reactstrap'

// it is the same as server's definition
export interface Pager {
  page: any
  pagesCount: number
  pages: number[]
  total: number
  previous: number | null
  previousDots: boolean
  next: number | null
  nextDots: boolean
}

interface Props {
  onClick: Function
  current?: number
  count?: number
  pager?: Pager
}

const PaginationWrapper: React.FC<Props> = props => {
  const { current, count, pager } = props

  const onClick = (i?: number | null) => {
    const { onClick } = props
    return (e: React.MouseEvent<HTMLElement>) => {
      e.preventDefault()
      onClick(i)
    }
  }

  // LegacyPagination
  if (!pager) {
    if (current && count && (current < 1 || count < 1)) {
      return null
    }

    return (
      <Pagination>
        <PaginationItem disabled={current === 1}>
          <PaginationLink previous onClick={onClick(1)} />
        </PaginationItem>
        {[...Array(count).keys()].map((v, k) => {
          const page = k + 1
          return (
            <PaginationItem key={page} active={page === current}>
              <PaginationLink onClick={onClick(page)}>{page}</PaginationLink>
            </PaginationItem>
          )
        })}
        <PaginationItem disabled={current === count}>
          <PaginationLink next onClick={onClick(count)} />
        </PaginationItem>
      </Pagination>
    )
  }

  return (
    <Pagination>
      {pager.page !== 1 && (
        <PaginationItem>
          <PaginationLink first onClick={onClick(1)} />
        </PaginationItem>
      )}
      {pager.previous && (
        <PaginationItem>
          <PaginationLink previous onClick={onClick(pager.previous)} />
        </PaginationItem>
      )}
      {pager.previousDots && (
        <PaginationItem>
          <PaginationLink href="#">...</PaginationLink>
        </PaginationItem>
      )}
      {pager.pages.map(p => {
        return (
          <PaginationItem key={p} active={p === pager.page}>
            <PaginationLink onClick={onClick(p)}>{p}</PaginationLink>
          </PaginationItem>
        )
      })}
      {pager.nextDots && (
        <PaginationItem>
          <PaginationLink href="#">...</PaginationLink>
        </PaginationItem>
      )}
      {pager.next && (
        <PaginationItem>
          <PaginationLink next onClick={onClick(pager.next)} />
        </PaginationItem>
      )}
      {pager.page !== pager.pagesCount && (
        <PaginationItem>
          <PaginationLink last onClick={onClick(pager.pagesCount)} />
        </PaginationItem>
      )}
    </Pagination>
  )
}

export default PaginationWrapper
