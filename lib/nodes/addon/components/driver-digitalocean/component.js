import { hash } from 'rsvp';
import {
  get, set, computed, observer, setProperties
} from '@ember/object';
import { alias } from '@ember/object/computed';
import Component from '@ember/component';
import NodeDriver, { registerDisplayLocation, registerDisplaySize } from 'shared/mixins/node-driver';
import fetch from '@rancher/ember-api-store/utils/fetch';
import { addQueryParam, addQueryParams } from 'shared/utils/util';
import layout from './template';
import { inject as service } from '@ember/service';

registerDisplayLocation(DRIVER, 'config.region');
registerDisplaySize(DRIVER, 'config.size');

const DRIVER = 'digitalocean';
const DIGITALOCEAN_API = 'api.digitalocean.com/v2';
const VALID_IMAGES = [
  'rancheros',
  'centos-7-x64',
  'coreos-alpha',
  'coreos-beta',
  'coreos-stable',
  'debian-8-x64',
  'debian-9-x64',
  'fedora-27-x64',
  'fedora-28-x64',
  'ubuntu-14-04-x64',
  'ubuntu-16-04-x64',
  'ubuntu-18-04-x64',
];

export default Component.extend(NodeDriver, {
  app:           service(),
  layout,

  driverName:    'digitalocean',
  regionChoices: null,
  model:         null,
  step:          1,
  sizeChoices:   null,
  imageChoices:  null,
  tags:          null,

  config:        alias('primaryResource.digitaloceanConfig'),

  init() {
    this._super(...arguments);

    this.initTags();
  },

  actions: {
    finishAndSelectCloudCredential(cred) {
      if (cred) {
        set(this, 'primaryResource.cloudCredentialId', get(cred, 'id'));

        this.send('getData');
      }
    },

    getData(cb) {
      let promises = {
        regions:  this.apiRequest('regions'),
        images:   this.apiRequest('images', { params: { type: 'distribution' } }),
        sizes:    this.apiRequest('sizes')
      };

      hash(promises).then((hash) => {
        let filteredRegions = hash.regions.regions.filter((region) => {
          return region.available && (region.features.indexOf('metadata') >= 0);
        }).sortBy('name');

        let filteredSizes = hash.sizes.sizes.map((size) => {
          size.memoryGb = size.memory / 1024;
          size.highMem = size.slug.indexOf('m-') >= 0;

          return size;
        }).filter((size) => {
          return size.available;
        }).sortBy('highMem', 'memory');

        let filteredImages = hash.images.images.filter((image) => {
          // 64-bit only
          return !((image.name || '').match(/x32$/));
        }).map((image) => {
          image.disabled = VALID_IMAGES.indexOf(image.slug) === -1;

          return image;
        });

        filteredImages = filteredImages.sortBy('distribution', 'name');

        setProperties(this, {
          regionChoices: filteredRegions,
          sizeChoices:   filteredSizes,
          imageChoices:  filteredImages,
          step:          2,
          errors:        null,
        });

        this.sendAction('hidePicker');
      }, (err) => {
        let errors = get(this, 'errors') || [];

        errors.push(`${ err.statusText }: ${ err.body.message }`);

        setProperties(this, { errors, });

        if (cb && typeof cb === 'function') {
          cb();
        }
      });
    },
  },

  imageChanged: observer('config.image', function() {
    const image = get(this, 'config.image');

    if ( image === 'rancheros' ) {
      set(this, 'config.sshUser', 'rancher');
    } else if ( image.startsWith('coreos') ) {
      set(this, 'config.sshUser', 'core');
    } else {
      set(this, 'config.sshUser', 'root');
    }
  }),

  tagsDidChange: observer('tags', function() {
    set(this, 'config.tags', get(this, 'tags').join(','));
  }),

  filteredSizeChoices: computed('config.region', function(){
    let region = get(this, 'regionChoices').findBy('slug', get(this, 'config.region'));
    let sizes = get(this, 'sizeChoices');
    let out = sizes.filter((size) => {
      return region.sizes.indexOf(size.slug) >= 0;
    });

    return out;
  }),

  initTags() {
    const tags = get(this, 'config.tags');

    if (tags) {
      set(this, 'tags', tags.split(','));
    }
  },

  bootstrap() {
    let config = get(this, 'globalStore').createRecord({
      type:    'digitaloceanConfig',
      size:    '2gb',
      region:  'nyc3',
      image:   'ubuntu-16-04-x64',
      sshUser: 'root'
    });

    const primaryResource = get(this, 'primaryResource');

    set(primaryResource, 'digitaloceanConfig', config);
  },

  apiRequest(command, opt, out) {
    opt = opt || {};

    let url               = `${ get(this, 'app.proxyEndpoint') }/`;
    let cloudCredentialId = get(this, 'primaryResource.cloudCredentialId');

    if ( opt.url ) {
      url += opt.url.replace(/^http[s]?\/\//, '');
    } else {
      url += `${ DIGITALOCEAN_API }/${ command }`;
      url = addQueryParam(url, 'per_page', opt.per_page || 100);
      url = addQueryParams(url, opt.params || {});
    }

    return fetch(url, {
      headers: {
        'Accept':                  'application/json',
        'x-api-cattleauth-header': `Bearer credID=${ cloudCredentialId } passwordField=accessToken`,
      },
    }).then((res) => {
      let body = res.body;

      if ( out ) {
        out[command].pushObjects(body[command]);
      } else {
        out = body;
      }

      // De-paging
      if ( body && body.links && body.links.pages && body.links.pages.next ) {
        opt.url = body.links.pages.next;

        return this.apiRequest(command, opt, out).then(() => {
          return out;
        });
      } else {
        return out;
      }
    });
  }
});
