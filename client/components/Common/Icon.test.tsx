import React from 'react'
import { shallow } from 'enzyme'
import Icon from './Icon'

describe('Icon', () => {
  describe('props', () => {
    it('should have same props', () => {
      const wrapper = shallow(<Icon name="account" />)
      const instance = wrapper.instance()

      expect(instance.props().name).toBe('account')
    })
  })
})
