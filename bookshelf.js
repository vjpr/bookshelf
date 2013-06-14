//     Bookshelf.js 0.1.5

//     (c) 2013 Tim Griesser
//     Bookshelf may be freely distributed under the MIT license.
//     For all details and documentation:
//     http://bookshelfjs.org
(function() {

  // Initial Setup
  // -------------
  var Bookshelf = {};

  // Keep a reference to our own copy of Backbone, in case we want to use
  // this specific instance elsewhere in the application.
  var Backbone = Bookshelf.Backbone = require('backbone');

  // Local dependency references.
  var _      = require('underscore');
  var when   = require('when');
  var Knex   = require('knex');
  var Inflection = require('inflection');

  // Mixin the `triggerThen` function into all relevant Backbone objects,
  // so we can have event driven async validations, functions, etc.
  require('trigger-then')(Backbone, when);

  // Keep in sync with `package.json`.
  Bookshelf.VERSION = '0.1.5';

  // We're using `Backbone.Events` rather than `EventEmitter`,
  // for consistency and portability.
  var Events = Bookshelf.Events = Backbone.Events;

  // `Bookshelf` may be used as a top-level pub-sub bus.
  _.extend(Bookshelf, Events);

  var push = Array.prototype.push;

  // Shared functions which are mixed-in to the
  // `Model`, `Collection`, and `EagerRelation` prototypes.
  var Shared = {

    // Returns an instance of the query builder.
    builder: function(table) {
      return Knex(table);
    },

    // If there are no arguments, return the current object's
    // query builder (or create and return a new one). If there are arguments,
    // call the query builder with the first argument, applying the rest.
    query: function() {
      this._builder || (this._builder = this.builder(_.result(this, 'tableName')));
      var args = _.toArray(arguments);
      if (args.length === 0) return this._builder;
      this._builder[args[0]].apply(this._builder, args.slice(1));
      return this;
    },

    // Reset the query builder, called internally
    // each time a query is run.
    resetQuery: function() {
      delete this._builder;
      return this;
    },

    // Eager loads relationships onto an already populated
    // `Model` or `Collection` instance.
    load: function(relations, options) {
      var target, data;
      if (!_.isArray(relations)) relations = relations ? [relations] : [];
      options = _.extend({}, options, {
        shallow: true,
        withRelated: relations
      });
      if (this instanceof Collection) {
        target = new this.model();
        data = this.toJSON(options);
      } else {
        target = this;
        data = [this.toJSON(options)];
      }
      var model = this;
      return new EagerRelation(this, target, data)
        .processRelated(options)
        .yield(model);
    },

    // Creates and returns a new `Bookshelf.Sync` instance.
    sync: function(model, options) {
      return new Bookshelf.Sync(model, options);
    },

    // Helper for attaching query constraints on related
    // `models` or `collections` as necessary.
    _addConstraints: function(resp) {
      var relation = this._relation;
      if (relation) {
        if (!relation.fkValue && !resp) {
          return when.reject(new Error("The " + relation.otherKey + " must be specified."));
        }
        if (relation.type === 'belongsToMany') {
          belongsToManyConstraints(this, resp);
        } else if (relation.type === 'morphTo' && resp) {
          morphToConstraints(this, resp);
          constraints(this, resp);
        } else {
          constraints(this, resp);
        }
      }
    }

  };

  // Bookshelf.Model
  // -------------------

  // A Bookshelf Model represents an individual row in the database table --
  // It has a similar implementation to the `Backbone.Model`
  // constructor, except that defaults are not set until the
  // object is persisted, and the collection property is not used.

  // A unique `cid` property is also added to each created model, similar to
  // `Backbone` models, and is useful checking the identity of two models.
  var Model = Bookshelf.Model = function(attributes, options) {
    var attrs = attributes || {};
    options || (options = {});
    this.attributes = Object.create(null);
    this._reset();
    this.relations = {};
    this.cid = _.uniqueId('c');
    if (options) {
      _.extend(this, _.pick(options, modelProps));
      if (options.parse) attrs = this.parse(attrs, options) || {};
    }
    this.set(attrs, options);
    this.initialize.apply(this, arguments);
  };

  // A list of properties that are omitted from the `Backbone.Model.prototype`, since we're not
  // handling validations, or tracking changes in the same fashion as `Backbone`, we can drop these
  // specific methods.
  var modelOmitted = ['isValid', 'validationError', 'changedAttributes'];

  // List of attributes attached directly from the `options` passed to the constructor.
  var modelProps = ['tableName', 'hasTimestamps'];

  _.extend(Model.prototype, _.omit(Backbone.Model.prototype, modelOmitted), Events, Shared, {

    // The `hasOne` relation specifies that this table has exactly one of
    // another type of object, specified by a foreign key in the other table. The foreign key is assumed
    // to be the singular of this object's `tableName` with an `_id` suffix, but a custom `foreignKey`
    // attribute may also be specified.
    hasOne: function(Target, foreignKey) {
      return this._hasOneOrMany(Target, foreignKey, 'hasOne');
    },

    // The `hasMany` relation specifies that this object has one or
    // more rows in another table which match on this object's primary key. The foreign key is assumed
    // to be the singular of this object's `tableName` with an `_id` suffix, but a custom `foreignKey`
    // attribute may also be specified.
    hasMany: function(Target, foreignKey) {
      return this._hasOneOrMany(Target, foreignKey, 'hasMany');
    },

    // A reverse `hasOne` relation, the `belongsTo`, where the specified key in this table
    // matches the primary `idAttribute` of another table.
    belongsTo: function(Target, otherKey) {
      return this._relatesTo(Target, {
        type: 'belongsTo',
        foreignKey: Target.prototype.idAttribute,
        otherKey: otherKey || singularMemo(_.result(Target.prototype, 'tableName')) + '_id'
      });
    },

    // A `belongsToMany` relation is when there are many-to-many relation
    // between two models, with a joining table. The joinTableName may be replaced with another
    // object, will serve as the joining model.
    belongsToMany: function(Target, joinTableName, foreignKey, otherKey) {
      return this._relatesTo(Target, {
        type: 'belongsToMany',
        otherKey: otherKey     || singularMemo(_.result(this, 'tableName')) + '_id',
        foreignKey: foreignKey || singularMemo(_.result(Target.prototype, 'tableName')) + '_id',
        joinTableName: joinTableName || [
          _.result(this, 'tableName'),
          _.result(Target.prototype, 'tableName')
        ].sort().join('_')
      });
    },

    // A `morphOne` relation is a one-to-one polymorphic association from this model
    // to another model.
    morphOne: function(Target, name) {
      return this._morphOneOrMany(Target, name, 'morphOne');
    },

    // A `morphMany` relation is a polymorphic many-to-one relation from this model
    // to many of another model.
    morphMany: function(Target, name) {
      return this._morphOneOrMany(Target, name, 'morphMany');
    },

    // Defines the opposite end of a `morphOne` or `morphMany` relationship, where
    // the alternate end of the polymorphic model is defined.
    morphTo: function(name) {
      var foreignTable = this.get(name + '_type');
      var candidates = _.rest(arguments);
      var Target = _.find(candidates, function(Candidate) {
        return (_.result(Candidate, 'tableName') === foreignTable);
      });
      if (!Target) {
        throw new Error('The target polymorphic model was not found');
      }
      return this._relatesTo(Target, {
        type: 'morphTo',
        foreignKey: Target.prototype.idAttribute,
        otherKey: name + '_id',
        candidates: candidates
      });
    },

    // Similar to the standard `Backbone` set method, but without individual
    // change events, and adding different meaning to `changed` and `previousAttributes`
    // defined as the last "sync"'ed state of the model.
    set: function(key, val, options) {
      if (key == null) return this;
      var attr, attrs, changing;

      // Handle both `"key", value` and `{key: value}` -style arguments.
      if (typeof key === 'object') {
        attrs = key;
        options = val;
      } else {
        (attrs = {})[key] = val;
      }
      options || (options = {});

      // Extract attributes and options.
      var hasChanged = false;
      var unset   = options.unset;
      var current = this.attributes;
      var prev    = this._previousAttributes;

      // Check for changes of `id`.
      if (this.idAttribute in attrs) this.id = attrs[this.idAttribute];

      // For each `set` attribute, update or delete the current value.
      for (attr in attrs) {
        val = attrs[attr];
        if (!_.isEqual(prev[attr], val)) {
          this.changed[attr] = val;
          if (!_.isEqual(current[attr], val)) hasChanged = true;
        } else {
          delete this.changed[attr];
        }
        unset ? delete current[attr] : current[attr] = val;
      }

      if (hasChanged && !options.silent) this.trigger('change', this, options);
      return this;
    },

    // Fetch a model based on the currently set attributes,
    // returning a model to the callback, along with any options.
    // Returns a deferred promise through the Bookshelf.sync.
    fetch: function(options) {
      return this.sync(this, options).first().then(function(model) {
        return model._reset();
      });
    },

    // Sets and saves the hash of model attributes, triggering
    // a "creating" or "updating" event on the model, as well as a "saving" event,
    // to bind listeners for any necessary validation, logging, etc.
    // If an error is thrown during these events, the model will not be saved.
    save: function(key, val, options) {
      var attrs;

      // Handle both `"key", value` and `{key: value}` -style arguments.
      if (key == null || typeof key === "object") {
        attrs = key || {};
        options = val || {};
      } else {
        options || (options = {});
        (attrs = {})[key] = val;
      }

      // If the model has timestamp columns,
      // set them as attributes on the model, even
      // if the "partial" option is specified.
      if (this.hasTimestamps) {
        _.extend(attrs, this.timestamp(options));
      }

      // Determine whether the model is new, typically based on whether the model has
      // an `idAttribute` or not.
      var method = options.method || (this.isNew(options) ? 'insert' : 'update');
      var vals = attrs;

      // If the object is being created, we merge any defaults here
      // rather than during object creation.
      if (method === 'insert' || options.defaults) {
        var defaults = _.result(this, 'defaults');
        if (defaults) {
          vals = _.extend({}, defaults, this.attributes, vals);
        }
      }

      // Set the attributes on the model, and maintain a reference to use below.
      var model  = this.set(vals, {silent: true});
      var sync   = model.sync(model, options);

      return when.all([
        model.triggerThen((method === 'insert' ? 'creating' : 'updating'), model, attrs, options),
        model.triggerThen('saving', model, attrs, options)
      ])
      .then(function() { return sync[method](attrs, options); })
      .then(function(resp) {

        // After a successful database save, the id is updated if the model was created
        if (method === 'insert' && resp) {
          model.attributes[model.idAttribute] = model[model.idAttribute] = resp[0];
        }
        model.trigger((method === 'insert' ? 'created' : 'updated'), model, resp, options);
        model.trigger('saved', model, resp, options);
        return model._reset();
      })
      .ensure(function() { model.resetQuery(); });
    },

    // Destroy a model, calling a "delete" based on its `idAttribute`.
    // A "destroying" and "destroyed" are triggered on the model before
    // and after the model is destroyed, respectively. If an error is thrown
    // during the "destroying" event, the model will not be destroyed.
    destroy: function(options) {
      options || (options = {});
      var model = this;
      return model.triggerThen('destroying', model, options)
      .then(function() { return model.sync(model, options).del(options); })
      .then(function(resp) {
        model.clear();
        model.trigger('destroyed', model, resp, options);
        return model._reset();
      }).ensure(function() {
        model.resetQuery();
      });
    },

    // **format** converts a model into the values that should be saved into
    // the database table. The default implementation is just to pass the response along.
    format: function(attrs, options) {
      return attrs;
    },

    // Returns an object containing a shallow copy of the model attributes,
    // along with the `toJSON` value of any relations,
    // unless `{shallow: true}` is passed in the `options`.
    toJSON: function(options) {
      var attrs = _.extend({}, this.attributes);
      if (options && options.shallow) return attrs;
      var relations = this.relations;
      for (var key in relations) {
        attrs[key] = relations[key].toJSON();
      }
      return attrs;
    },

    // Sets the timestamps before saving the model.
    timestamp: function(options) {
      var d = new Date();
      var vals = {};
      vals.updated_at = d;
      if (this.isNew(options)) vals.created_at = d;
      return vals;
    },

    // Create a new model with identical attributes to this one,
    // including any relations on the current model.
    clone: function() {
      var model = new this.constructor(this.attributes);
      var relations = this.relations;
      for (var key in relations) {
        model.relations[key] = relations[key].clone();
      }
      model._previousAttributes = _.clone(this._previousAttributes);
      model.changed = _.clone(this.changed);
      return model;
    },

    // Helper for setting up the `hasOne` or `hasMany` relations.
    _hasOneOrMany: function(Target, foreignKey, type) {
      return this._relatesTo(Target, {
        type: type,
        foreignKey: foreignKey || singularMemo(_.result(this, 'tableName')) + '_id'
      });
    },

    // Helper for setting up the `morphOne` or `morphMany` relations.
    _morphOneOrMany: function(Target, name, type) {
      if (!name) throw new Error('The polymorphic `name` is required.');
      return this._relatesTo(Target, {
        type: type,
        name: name,
        foreignKey: name + '_id',
        morphKey: name + '_type',
        morphValue: _.result(this, 'tableName')
      });
    },

    // Creates a new relation, from the current object to the
    // 'target' object (collection or model), passing a hash of
    // options which can include the `type` of relation.
    // The `hasOne` and `belongsTo` relations may only "target" a `Model`.
    _relatesTo: function(Target, options) {
      var target, data;
      var type = options.type;
      var multi = (type === 'hasMany' || type === 'belongsToMany' || type === 'morphMany');
      var single = (type === 'belongsTo' || type === 'morphTo');

      if (!multi) {
        data = {};
        if (!Target.prototype instanceof Model) {
          throw new Error('The `'+type+'` related object must be a Bookshelf.Model');
        }
      } else if (Target.prototype instanceof Model) {
        Target = Bookshelf.Collection.extend({
          model: Target,
          builder: Target.prototype.builder
        });
      }

      // If we're handling an eager loaded related model,
      // keep a reference to the original constructor to assemble
      // the correct object once the eager matching is finished.
      // Otherwise, just grab the `foreignKey` value for building the query.
      if (this._isEager) {
        if (multi) {
          options.modelCtor = Target.prototype.model;
          options.collectionCtor = Target;
        } else {
          options.modelCtor = Target;
        }
        options.parentIdAttr = (single ? options.otherKey : _.result(this, 'idAttribute'));
      } else {
        if (type === 'belongsTo') {
          options.fkValue = this.get(options.otherKey);
        } else {
          options.fkValue = this.id;
        }
        if (!multi) {
          data[options.foreignKey] = options.fkValue;
          if (options.morphKey) data[options.morphKey] = options.morphValue;
        }
      }

      // Create a new instance of the `Model` or `Collection`, and set the
      // `_relation` options as a property on the instance.
      target = new Target(data);
      target._relation = options;

      // Extend the relation with relation-specific methods.
      if (type === 'belongsToMany') {
        _.extend(target, pivotHelpers);
      }

      return target;
    },

    // Returns the related item, or creates a new
    // related item by creating a new model or collection.
    related: function(name) {
      return this.relations[name] || (this.relations[name] = this[name]());
    },

    // Called after a `sync` action (save, fetch, delete) -
    // resets the `_previousAttributes` and `changed` hash for the model.
    _reset: function() {
      this._previousAttributes = extendNull(this.attributes);
      this.changed = extendNull();
      return this;
    },

    // Validation can be complicated, and is better handled
    // on its own and not mixed in with database logic.
    _validate: function() {
      return true;
    }

  });

  // Bookshelf.Collection
  // -------------------

  // A Bookshelf Collection contains a number of database rows, represented by
  // models, so they can be easily sorted, serialized, and manipulated.
  var Collection = Bookshelf.Collection = function(models, options) {
    if (options) _.extend(this, _.pick(options, collectionProps));
    var model = this.model;
    if (!_.isEqual(model, Model) && !(model.prototype instanceof Model)) {
      throw new Error('Only Bookshelf Model constructors are allowed as the Collection#model attribute.');
    }
    this._reset();
    this.initialize.apply(this, arguments);
    if (models) this.reset(models, _.extend({silent: true}, options));
  };

  // List of attributes attached directly from the constructor's options object.
  var collectionProps = ['model', 'comparator'];

  // Extend the Collection's prototype with the base methods
  _.extend(Collection.prototype, _.omit(Backbone.Collection.prototype, 'model'), Events, Shared, {

    model: Model,

    // Fetch the models for this collection, resetting the models for the query
    // when they arrive.
    fetch: function(options) {
      return this.sync(this, options).select();
    },

    // Shortcut for creating a new model, saving, and adding to the collection.
    // Returns a promise which will resolve with the model added to the collection.
    create: function(model, options) {
      options || (options = {});
      model = this._prepareModel(model, options);
      var collection = this;
      return model.save(null, options).then(function() {
        collection.add(model, options);
        return model;
      });
    },

    // The `tableName` on the associated Model, used in relation building.
    tableName: function() {
      return _.result(this.model.prototype, 'tableName');
    },

    // The `idAttribute` on the associated Model, used in relation building.
    idAttribute: function() {
      return this.model.prototype.idAttribute;
    },

    // Signifies whether the associated Model is flagged as polymorphic,
    // required for eager `morphTo` relations.
    polymorphic: function() {
      return this.model.prototype.polymorphic;
    },

    // Prepare a model or hash of attributes to be added to this collection.
    _prepareModel: function(attrs, options) {
      if (attrs instanceof Model) return attrs;
      return new this.model(attrs, options);
    }

  });

  // Bookshelf.EagerRelation
  // ---------------

  // An `EagerRelation` object temporarily stores the models from an eager load,
  // and handles matching eager loaded objects with their parent(s).
  var EagerRelation = Bookshelf.EagerRelation = function(parent, target, parentResponse) {
    this.parent = parent;
    this.target = target;
    this.parentResponse = parentResponse;
  };

  _.extend(EagerRelation.prototype, Shared, {

    // This helper function is used internally to determine which relations
    // are necessary for fetching based on the `model.load` or `withRelated` option.
    processRelated: function(options) {
      var name, related, relation;
      var target = this.target;
      var handled = this.handled = {};
      var withRelated = options.withRelated;
      var subRelated = {};
      if (!_.isArray(withRelated)) withRelated = withRelated ? [withRelated] : [];

      // Eager load each of the `withRelated` relation item, splitting on '.'
      // which indicates a nested eager load.
      for (var i = 0, l = options.withRelated.length; i < l; i++) {
        related = options.withRelated[i].split('.');
        name = related[0];

        // Add additional eager items to an array, to load at the next level in the query.
        if (related.length > 1) {
          subRelated[name] || (subRelated[name] = []);
          subRelated[name].push(related.slice(1).join('.'));
        }

        // Only allow one of a certain nested type per-level.
        if (handled[name]) continue;

        // Internal flag to determine whether to set the ctor(s) on the _relation hash.
        target._isEager = true;
        relation = target[name]();
        delete target._isEager;

        // Set the parent's response, for purposes of setting query constraints.
        relation._relation.parentResponse = this.parentResponse;

        if (!relation) {
          throw new Error(name + ' is not defined on the model.');
        }

        handled[name] = relation;
      }

      // Fetch all eager loaded models, loading them onto
      // an array of pending deferred objects, so we easily
      // re-organize the responses once all of the queries complete.
      var pendingDeferred = [];
      var pendingNames = this.pendingNames = [];
      for (name in handled) {
        pendingNames.push(name);
        pendingDeferred.push(eagerFetch(handled[name], {
          transacting: options.transacting,
          withRelated: subRelated[name]
        }));
      }

      // Return a deferred handler for all of the nested object sync
      // returning the original response when these syncs are complete.
      return when.all(pendingDeferred).spread(_.bind(this.matchResponses, this));
    },

    // Handles the matching against an eager loaded relation.
    matchResponses: function() {
      var args = _.toArray(arguments);
      var parent  = this.parent;
      var handled = this.handled;

      // Pair each of the query responses with the parent models.
      for (var i = 0, l = args.length; i < l; i++) {

        // Get the current relation this response matches up with, based
        // on the pendingNames array.
        var name = this.pendingNames[i];
        var relation = handled[name];
        var type = relation._relation.type;
        var relatedModels = new RelatedModels(relation.models);

        // If the parent is a collection, we need to loop over each of the
        // models and attach the appropriate sub-models, since they are
        // fetched eagerly. We will re-use the same models for each association level.
        if (parent instanceof Collection) {
          var models = parent.models;

          // Attach the appropriate related items onto the parent model.
          for (var i2 = 0, l2 = models.length; i2 < l2; i2++) {
            var m  = models[i2];
            var id = (type === 'belongsTo' ? m.get(relation._relation.otherKey) : m.id);
            m.relations[name] = eagerAssociate(type, relation, relatedModels, id);
          }
        } else {
          // If this is a hasOne or belongsTo, we only choose a single item from
          // the relation.
          if (type === 'hasOne' || type === 'morphOne' || type === 'belongsTo' || type  === 'morphTo') {
            parent.relations[name] = relation.models[0] || new relation._relation.modelCtor();
          } else {
            parent.relations[name] = new relation._relation.collectionCtor(relation.models, {parse: true});
          }
        }
      }

      return this.parentResponse;
    }
  });

  // Temporary helper object for handling the response of an `EagerRelation` load.
  var RelatedModels = function(models) {
    this.models = models;
    this.length = this.models.length;
  };
  _.extend(RelatedModels.prototype, _.pick(Collection.prototype, 'find', 'where', 'filter', 'findWhere'));

  // Called from `EagerRelation.processRelated`, this fetches the
  // nested related items, and returns a deferred object, with the
  // cumulative handling of multiple (potentially nested) relations.
  var eagerFetch = function(related, options) {
    var models   = related.models = [];
    var relation = related._relation;

    return when(related._addConstraints(relation.parentResponse)).then(function() {
      return related.query().select(relation.columns);
    })
    .then(function(resp) {

      // Only find additional related items & process if
      // there is a response from the query.
      if (resp && resp.length > 0) {

        // We can just push the models onto the collection, rather than resetting.
        for (var i = 0, l = resp.length; i < l; i++) {
          models.push(new relation.modelCtor(resp[i], {parse: true})._reset());
        }

        if (options.withRelated) {
          var model = new relation.modelCtor();
          return new EagerRelation(related, model, resp).processRelated(options);
        }
      }

      return models;
    }).ensure(function() {
      related.resetQuery();
    });
  };

  // Handles the "eager related" relationship matching.
  var eagerAssociate = function(type, target, eager, id) {
    var relation = target._relation;
    var where = {};
    if (type === 'hasOne' || type === 'belongsTo' || type === 'morphOne' || type === 'morphTo') {
      where[relation.foreignKey] = id;
      return eager.findWhere(where) || new relation.modelCtor();
    } else if (type === 'hasMany' || type === 'morphMany') {
      where[relation.foreignKey] = id;
      if (type === 'morphMany') where[relation.morphKey] = relation.morphValue;
      return new relation.collectionCtor(eager.where(where), {parse: true});
    } else {
      where['_pivot_' + relation.otherKey] = id;
      return new relation.collectionCtor(eager.where(where), {parse: true});
    }
  };

  // Standard constraints for regular or eager loaded relations.
  // If the model isn't an eager load or a collection, it doesn't need
  // to be populated with the additional `where` clause, as that's already taken
  // care of during model creation.
  var constraints = function(target, resp) {
    var relation = target._relation;
    var builder  = target.query();
    if (resp) {
      builder.whereIn(relation.foreignKey, _.uniq(_.pluck(resp, relation.parentIdAttr)));
    } else if (target instanceof Collection) {
      builder.where(relation.foreignKey, relation.fkValue);
    }
    if (relation.type === 'morphMany') builder.where(relation.morphKey, relation.morphValue);
  };

  // Helper function for adding the constraints needed on a eager load.
  var belongsToManyConstraints = function(target, resp) {
    var
    relation      = target._relation,
    columns       = relation.columns || (relation.columns = []),
    builder       = target.query(),

    tableName     = _.result(target, 'tableName'),
    idAttribute   = _.result(target, 'idAttribute'),

    otherKey      = relation.otherKey,
    foreignKey    = relation.foreignKey,
    pivotColumns  = relation.pivotColumns,
    joinTableName = relation.joinTableName;

    if (builder.columns.length === 0 && columns.length === 0) {
      columns.push(tableName + '.*');
    }

    columns.push(
      joinTableName + '.' + otherKey + ' as ' + '_pivot_' + otherKey,
      joinTableName + '.' + foreignKey + ' as ' + '_pivot_' + foreignKey
    );

    if (pivotColumns) push.apply(columns, pivotColumns);

    builder.join(joinTableName, tableName + '.' + idAttribute, '=', joinTableName + '.' + foreignKey);

    if (resp) {
      builder.whereIn(joinTableName + '.' + otherKey, _.pluck(resp, idAttribute));
    } else {
      builder.where(joinTableName + '.' + otherKey, '=', relation.fkValue);
    }
  };

  // Helper function for adding the constraints needed for a `morphTo` eager load.
  var morphToConstraints = function(target, resp) {
    var relation = target._relation;
  };

  // Set up inheritance for the model and collection.
  Model.extend = Collection.extend = EagerRelation.extend = Bookshelf.Backbone.Model.extend;

  // The `forge` function properly instantiates a new Model or Collection
  // without needing the "new" keyword... to make object creation cleaner
  // and more chainable.
  Model.forge = Collection.forge = function() {
    var inst = Object.create(this.prototype);
    var obj = this.apply(inst, arguments);
    return (Object(obj) === obj ? obj : inst);
  };

  // Bookshelf.Sync
  // -------------------

  // Sync is the dispatcher for any database queries,
  // taking the `model` or `collection` being queried, along with
  // a hash of options that are used in the various query methods.
  // If the `transacting` option is set, the query is assumed to be
  // part of a transaction, and this information is passed along to `Knex`.
  var Sync = Bookshelf.Sync = function(model, options) {
    options || (options = {});
    this.model = model;
    this.options = options;
    this.query = model.query();
    if (options.transacting) this.query.transacting(options.transacting);
  };

  _.extend(Sync.prototype, {

    // Select the first item from the database - only used by models.
    first: function() {
      this.query.where(extendNull(this.model.attributes)).limit(1);
      return this.select();
    },

    // Runs a `select` query on the database, adding any necessary relational
    // constraints, resetting the query when complete. If there are results and
    // eager loaded relations, those are fetched and returned on the model before
    // the promise is resolved. Any `success` handler passed in the
    // options will be called - used by both models & collections.
    select: function() {
      var sync = this;
      var options = sync.options;
      var model = this.model;

      return when(model._addConstraints()).then(function() {
        var columns = options.columns;

        if (!_.isArray(columns)) columns = columns ? [columns] : ['*'];

        if (model._relation && model._relation.columns) {
          columns = model._relation.columns;
        }

        return model.triggerThen('fetching', model, columns, options).then(function() {
          return sync.query.select(columns);
        });
      })
      .then(function(resp) {

        if (resp && resp.length > 0) {

          // If this is a model fetch, then we set the parsed attributes
          // on the model, otherwise, we reset the collection.
          if (model instanceof Model) {
            model.set(model.parse(resp[0], options), _.extend({silent: true}, options))._reset();
          } else {
            model.reset(resp, {silent: true, parse: true}).each(function(m) { m._reset(); });
          }

          // If the `withRelated` property is specified on the options hash, we dive
          // into the `EagerRelation`. If the current querying object is a collection,
          // we find the associated `model` to determine necessary eager relations.
          // Once the `EagerRelation` is complete, we return the original response from the query.
          if (options.withRelated) {
            var target = (model instanceof Collection ? new model.model() : model);
            return new EagerRelation(model, target, resp)
              .processRelated(options)
              .yield(resp);
          }

          return resp;
        }

        // If `{require: true}` is set as an option, the fetch is considered
        // a failure if the model comes up blank.
        if (options.require) return when.reject(new Error('EmptyResponse'));

        if (model instanceof Model) {
          model.clear({silent: true})._reset();
          return {};
        }

        model.reset([], {silent: true});
        return [];

      }).then(function(resp) {
        if (resp.length > 0) {
          model.trigger('fetched', model, resp, options);
        }
        return model;
      }).ensure(function() {
        model.resetQuery();
      });
    },

    // Issues an `insert` command on the query - only used by models.
    insert: function() {
      var model = this.model;
      return this.query
        .idAttribute(model.idAttribute)
        .insert(model.format(extendNull(model.attributes)))
        .then(function(resp) {
          model._previousAttributes = extendNull(model.attributes);
          return resp;
        });
    },

    // Issues an `update` command on the query - only used by models.
    update: function(attrs, options) {
      var model = this.model;
      return this.query
        .where(model.idAttribute, model.id)
        .update(model.format(extendNull(model.attributes)))
        .then(function(resp) {
          model._previousAttributes = extendNull(model.attributes);
          return resp;
        });
    },

    // Issues a `delete` command on the query.
    del: function() {
      var wheres, model = this.model;
      if (this.model.id != null) {
        wheres = {};
        wheres[this.model.idAttribute] = this.model.id;
      }
      if (!wheres && this.query.wheres.length === 0) {
        return when.reject(new Error('A model cannot be destroyed without a "where" clause or an idAttribute.'));
      }
      return this.query.where(wheres).del();
    }
  });

  // Helpers
  // -------------------

  // Specific to many-to-many relationships, these methods are mixed
  // into the `belongsToMany` relationships when they are created,
  // providing helpers for attaching and detaching related models.
  var pivotHelpers = {

    // Attach one or more "ids" from a foreign
    // table to the current. Creates & saves a new model
    // and attaches the model with a join table entry.
    attach: function(ids, options) {
      return this._handler('insert', ids, options);
    },

    // Detach related object from their pivot tables.
    // If a model or id is passed, it attempts to remove the
    // pivot table based on that foreign key. If a hash is passed,
    // it attempts to remove the item based on a where clause with
    // these parameters. If no parameters are specified, we assume we will
    // detach all related associations.
    detach: function(ids, options) {
      return this._handler('delete', ids, options);
    },

    // Selects any additional columns on the pivot table,
    // taking a hash of columns which specifies the pivot
    // column name, and the value the column should take on the
    // output to the model attributes.
    withPivot: function(columns) {
      if (!_.isArray(columns)) columns = columns ? [columns] : [];
      var relation = this._relation;
      relation.pivotColumns || (relation.pivotColumns = []);
      for (var i = 0, l = columns.length; i < l; i++) {
        var column = columns[i];
        if (_.isString(column)) {
          relation.pivotColumns.push(relation.joinTableName + '.' + column + ' as pivot_' + column);
        } else {
          for (var key in column) {
            relation.pivotColumns.push(relation.joinTableName + '.' + key + ' as ' + column[key]);
          }
        }
      }
      return this;
    },

    // Helper for handling either the `attach` or `detach` call on
    // the `belongsToMany` relationship.
    _handler: function(method, ids, options) {
      if (ids == void 0 && method === 'insert') return when.resolve();
      if (!_.isArray(ids)) ids = ids ? [ids] : [];
      var pending = [];
      for (var i = 0, l = ids.length; i < l; i++) {
        pending.push(this._processPivot(method, ids[i], options));
      }
      return when.all(pending);
    },

    // Handles setting the appropriate constraints and shelling out
    // to either the `insert` or `delete` call for the current model,
    // returning a promise.
    _processPivot: function(method, item, options) {
      var data = {};
      var pivot = this._relation;
      data[pivot.otherKey] = pivot.fkValue;

      // If the item is an object, it's either a model
      // that we're looking to attach to this model, or
      // a hash of attributes to set in the relation.
      if (_.isObject(item)) {
        if (item instanceof Model) {
          data[pivot.foreignKey] = item.id;
        } else {
          _.extend(data, item);
        }
      } else if (item) {
        data[pivot.foreignKey] = item;
      }
      var builder = this.builder(pivot.joinTableName);
      if (options && options.transacting) {
        builder.transacting(options.transacting);
      }
      if (method === 'delete') return builder.where(data).del();
      return builder.insert(data);
    }

  };

  // Creates a new object, extending an object that
  // does not inherit the `Object.prototype`.
  var extendNull = function(target) {
    return _.extend(Object.create(null), target);
  };

  // Simple memoization of the singularize call.
  var singularMemo = (function() {
    var cache = Object.create(null);
    return function(arg) {
      if (arg in cache) {
        return cache[arg];
      } else {
        return cache[arg] = Inflection.singularize(arg);
      }
    };
  }());

  // References to the default `Knex` and `Knex.Transaction`, overwritten
  // when a new database connection is created in `Initialize` below.
  Bookshelf.Knex = Knex;
  Bookshelf.Transaction = Knex.Transaction;

  // Bookshelf.Initialize
  // -------------------

  // Configure the `Bookshelf` settings (database adapter, etc.) once,
  // so it is ready on first model initialization.
  Bookshelf.Initialize = function(name, options) {
    var Target;
    if (_.isObject(name)) {
      options = name;
      name = 'main';
    }
    if (Bookshelf.Instances[name]) {
      throw new Error('A ' + name + ' instance of Bookshelf already exists');
    }

    // If an object with this name already exists in `Knex.Instances`, we will
    // use that copy of `Knex` without trying to re-initialize.
    var Builder = (Knex[name] || Knex.Initialize(name, options));

    if (name === 'main') {
      Target = Bookshelf.Instances['main'] = Bookshelf;
    } else {
      Target = Bookshelf.Instances[name] = {};

      // Create a new `Bookshelf` instance for this database connection.
      _.extend(Target, _.omit(Bookshelf, 'Instances', 'Initialize', 'Knex', 'Transaction', 'VERSION'), {
        Knex: Builder,
        Transaction: Builder.Transaction
      });

      // Attach a new builder function that references the correct connection.
      _.each(['Model', 'Collection', 'EagerRelation'], function(item) {
        Target[item] = Bookshelf[item].extend({
          builder: function(table) {
            return Builder(table);
          }
        });
      });
    }

    // Set the instanceName, so we know what Bookshelf we're using.
    Target.instanceName = name;

    // Return the initialized instance.
    return Target;
  };

  // Named instances of Bookshelf, presumably with different `Knex`
  // options, to initialize different databases.
  // The main instance being named "main"...
  Bookshelf.Instances = {};

  // The main Bookshelf `instanceName`... incase we're using Bookshelf
  // after `Knex` has been initialized, for consistency.
  Bookshelf.instanceName = 'main';

  module.exports = Bookshelf;

}).call(this);