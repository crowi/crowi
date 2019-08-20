import React from 'react'
import styled from 'styled-components'

const StyledPager = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  margin: 10px 0;
`

const PagerButton = styled.div`
  width: 50%;
  margin: 0;
  text-align: center;
  font-size: small;
`

interface Props {
  hasPrev: boolean
  hasNext: boolean
  handlePrevClick: Function
  handleNextClick: Function
}

export default class Pager extends React.Component<Props> {
  static defaultProps = {
    hasPrev: false,
    hasNext: false,
  }

  handleOnPrevClick(e: React.MouseEvent<HTMLAnchorElement>) {
    e.preventDefault()
    this.props.handlePrevClick()
  }

  handleOnNextClick(e: React.MouseEvent<HTMLAnchorElement>) {
    e.preventDefault()
    this.props.handleNextClick()
  }

  render() {
    const { hasPrev, hasNext } = this.props

    return (
      <StyledPager>
        {hasPrev && (
          <PagerButton>
            <a onClick={this.handleOnPrevClick.bind(this)}>Prev</a>
          </PagerButton>
        )}
        {hasNext && (
          <PagerButton>
            <a onClick={this.handleOnNextClick.bind(this)}>Next</a>
          </PagerButton>
        )}
      </StyledPager>
    )
  }
}
