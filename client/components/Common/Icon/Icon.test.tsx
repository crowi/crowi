import React from 'react'
import { mount } from 'enzyme'
import { Icon } from 'components/Common/Icon/Icon'

describe('Icon', () => {
  describe('props', () => {
    it('should have same props', () => {
      const wrapper = mount(<Icon name="account" />)

      expect(wrapper.props().name).toBe('account')
    })
  })
})
