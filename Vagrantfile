# -*- mode: ruby -*-
# vi: set ft=ruby :
# All Vagrant configuration is done below. The "2" in Vagrant.configure
# configures the configuration version (we support older styles for
# backwards compatibility). Please don't change it unless you know what
# you're doing.
Vagrant.configure(2) do |config|

  config.vm.box = "bento/ubuntu-16.04"
  ## port forwarding
  # MongoDB
  config.vm.network "forwarded_port", guest: 27017, host: 27017, host_ip: "127.0.0.1"
  # Redis
  config.vm.network "forwarded_port", guest: 6379, host: 6379, host_ip: "127.0.0.1"
  # ElasticSearch
  config.vm.network "forwarded_port", guest: 9200, host: 9200, host_ip: "127.0.0.1"
  config.vm.network "forwarded_port", guest: 9100, host: 9100, host_ip: "127.0.0.1"
  # Provider Options
  config.vm.provider "virtualbox" do |vb|
    vb.customize ["modifyvm", :id, "--cpus", "2"]
    vb.customize ["modifyvm", :id, "--ioapic", "on"]
    vb.customize ["modifyvm", :id, "--memory", "4096"]
    # see: http://qiita.com/chatii0079/items/b60abd6ab2822b49290a
    vb.customize ["modifyvm", :id, "--cableconnected1", "on"]
  end
  # don't replace insecure key
  config.ssh.insert_key = false
end
