// Kept in parity with migration 004; integration tests exercise API and direct SQL.
export const classificationSchema = {
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schemaVersion",
    "context",
    "workItems",
    "amounts",
    "permit",
    "conditions",
    "note"
  ],
  "properties": {
    "schemaVersion": {
      "type": "integer",
      "enum": [
        1
      ]
    },
    "context": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "market",
        "companyRole",
        "workKind",
        "targetKind"
      ],
      "properties": {
        "market": {
          "anyOf": [
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "state",
                "value",
                "reason"
              ],
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "unanswered",
                    "unknown"
                  ]
                },
                "value": {
                  "type": "null"
                },
                "reason": {
                  "type": "null"
                }
              }
            },
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "state",
                "value",
                "reason"
              ],
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "known"
                  ]
                },
                "value": {
                  "type": "string",
                  "enum": [
                    "private",
                    "public"
                  ]
                },
                "reason": {
                  "type": "null"
                }
              }
            }
          ]
        },
        "companyRole": {
          "anyOf": [
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "state",
                "value",
                "reason"
              ],
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "unanswered",
                    "unknown"
                  ]
                },
                "value": {
                  "type": "null"
                },
                "reason": {
                  "type": "null"
                }
              }
            },
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "state",
                "value",
                "reason"
              ],
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "known"
                  ]
                },
                "value": {
                  "type": "string",
                  "enum": [
                    "prime_contractor",
                    "subcontractor",
                    "owner",
                    "other"
                  ]
                },
                "reason": {
                  "type": "null"
                }
              }
            }
          ]
        },
        "workKind": {
          "anyOf": [
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "state",
                "value",
                "reason"
              ],
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "unanswered",
                    "unknown"
                  ]
                },
                "value": {
                  "type": "null"
                },
                "reason": {
                  "type": "null"
                }
              }
            },
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "state",
                "value",
                "reason"
              ],
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "known"
                  ]
                },
                "value": {
                  "type": "string",
                  "enum": [
                    "repair",
                    "renovation",
                    "demolition",
                    "new_build",
                    "other"
                  ]
                },
                "reason": {
                  "type": "null"
                }
              }
            }
          ]
        },
        "targetKind": {
          "anyOf": [
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "state",
                "value",
                "reason"
              ],
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "unanswered",
                    "unknown"
                  ]
                },
                "value": {
                  "type": "null"
                },
                "reason": {
                  "type": "null"
                }
              }
            },
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "state",
                "value",
                "reason"
              ],
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "known"
                  ]
                },
                "value": {
                  "type": "string",
                  "enum": [
                    "building",
                    "structure",
                    "other"
                  ]
                },
                "reason": {
                  "type": "null"
                }
              }
            }
          ]
        }
      }
    },
    "workItems": {
      "type": "array",
      "minItems": 0,
      "maxItems": 12,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "id",
          "description",
          "tradeCandidates",
          "relationship",
          "parentItemId"
        ],
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
          },
          "description": {
            "type": "string",
            "minLength": 1,
            "maxLength": 300
          },
          "tradeCandidates": {
            "anyOf": [
              {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "state",
                  "value",
                  "reason"
                ],
                "properties": {
                  "state": {
                    "type": "string",
                    "enum": [
                      "unanswered",
                      "unknown"
                    ]
                  },
                  "value": {
                    "type": "null"
                  },
                  "reason": {
                    "type": "null"
                  }
                }
              },
              {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "state",
                  "value",
                  "reason"
                ],
                "properties": {
                  "state": {
                    "type": "string",
                    "enum": [
                      "known"
                    ]
                  },
                  "value": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 29,
                    "uniqueItems": true,
                    "items": {
                      "type": "string",
                      "enum": [
                        "civil_general",
                        "building_general",
                        "carpentry",
                        "plastering",
                        "scaffolding_earthwork_concrete",
                        "stone",
                        "roofing",
                        "electrical",
                        "plumbing",
                        "tile_brick_block",
                        "steel_structure",
                        "reinforcing_steel",
                        "paving",
                        "dredging",
                        "sheet_metal",
                        "glass",
                        "painting",
                        "waterproofing",
                        "interior_finishing",
                        "machinery_installation",
                        "thermal_insulation",
                        "telecommunications",
                        "landscaping",
                        "well_drilling",
                        "fittings",
                        "water_facilities",
                        "fire_protection",
                        "sanitation_facilities",
                        "demolition"
                      ]
                    }
                  },
                  "reason": {
                    "type": "null"
                  }
                }
              }
            ]
          },
          "relationship": {
            "anyOf": [
              {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "state",
                  "value",
                  "reason"
                ],
                "properties": {
                  "state": {
                    "type": "string",
                    "enum": [
                      "unanswered",
                      "unknown"
                    ]
                  },
                  "value": {
                    "type": "null"
                  },
                  "reason": {
                    "type": "null"
                  }
                }
              },
              {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "state",
                  "value",
                  "reason"
                ],
                "properties": {
                  "state": {
                    "type": "string",
                    "enum": [
                      "known"
                    ]
                  },
                  "value": {
                    "type": "string",
                    "enum": [
                      "primary",
                      "ancillary",
                      "independent"
                    ]
                  },
                  "reason": {
                    "type": "null"
                  }
                }
              }
            ]
          },
          "parentItemId": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
              },
              {
                "type": "null"
              }
            ]
          }
        }
      }
    },
    "amounts": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "contract",
        "suppliedMaterials",
        "suppliedMaterialValue",
        "suppliedMaterialTransport",
        "splitContracts",
        "relatedContractValue",
        "splitReason",
        "subcontracting",
        "subcontractTotal"
      ],
      "properties": {
        "contract": {
          "anyOf": [
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "state",
                "value",
                "reason"
              ],
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "unanswered",
                    "unknown"
                  ]
                },
                "value": {
                  "type": "null"
                },
                "reason": {
                  "type": "null"
                }
              }
            },
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "state",
                "value",
                "reason"
              ],
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "known"
                  ]
                },
                "value": {
                  "type": "object",
                  "additionalProperties": false,
                  "required": [
                    "yen",
                    "taxBasis"
                  ],
                  "properties": {
                    "yen": {
                      "type": "string",
                      "pattern": "^(0|[1-9][0-9]{0,11})$"
                    },
                    "taxBasis": {
                      "type": "string",
                      "enum": [
                        "tax_included",
                        "tax_excluded",
                        "unknown"
                      ]
                    }
                  }
                },
                "reason": {
                  "type": "null"
                }
              }
            }
          ]
        },
        "suppliedMaterials": {
          "anyOf": [
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "state",
                "value",
                "reason"
              ],
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "unanswered",
                    "unknown"
                  ]
                },
                "value": {
                  "type": "null"
                },
                "reason": {
                  "type": "null"
                }
              }
            },
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "state",
                "value",
                "reason"
              ],
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "known"
                  ]
                },
                "value": {
                  "type": "string",
                  "enum": [
                    "yes",
                    "no"
                  ]
                },
                "reason": {
                  "type": "null"
                }
              }
            }
          ]
        },
        "suppliedMaterialValue": {
          "anyOf": [
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "state",
                "value",
                "reason"
              ],
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "unanswered",
                    "unknown"
                  ]
                },
                "value": {
                  "type": "null"
                },
                "reason": {
                  "type": "null"
                }
              }
            },
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "state",
                "value",
                "reason"
              ],
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "known"
                  ]
                },
                "value": {
                  "type": "object",
                  "additionalProperties": false,
                  "required": [
                    "yen",
                    "taxBasis"
                  ],
                  "properties": {
                    "yen": {
                      "type": "string",
                      "pattern": "^(0|[1-9][0-9]{0,11})$"
                    },
                    "taxBasis": {
                      "type": "string",
                      "enum": [
                        "tax_included",
                        "tax_excluded",
                        "unknown"
                      ]
                    }
                  }
                },
                "reason": {
                  "type": "null"
                }
              }
            },
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "state",
                "value",
                "reason"
              ],
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "not_applicable"
                  ]
                },
                "value": {
                  "type": "null"
                },
                "reason": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 300
                }
              }
            }
          ]
        },
        "suppliedMaterialTransport": {
          "anyOf": [
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "state",
                "value",
                "reason"
              ],
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "unanswered",
                    "unknown"
                  ]
                },
                "value": {
                  "type": "null"
                },
                "reason": {
                  "type": "null"
                }
              }
            },
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "state",
                "value",
                "reason"
              ],
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "known"
                  ]
                },
                "value": {
                  "type": "object",
                  "additionalProperties": false,
                  "required": [
                    "yen",
                    "taxBasis"
                  ],
                  "properties": {
                    "yen": {
                      "type": "string",
                      "pattern": "^(0|[1-9][0-9]{0,11})$"
                    },
                    "taxBasis": {
                      "type": "string",
                      "enum": [
                        "tax_included",
                        "tax_excluded",
                        "unknown"
                      ]
                    }
                  }
                },
                "reason": {
                  "type": "null"
                }
              }
            },
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "state",
                "value",
                "reason"
              ],
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "not_applicable"
                  ]
                },
                "value": {
                  "type": "null"
                },
                "reason": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 300
                }
              }
            }
          ]
        },
        "splitContracts": {
          "anyOf": [
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "state",
                "value",
                "reason"
              ],
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "unanswered",
                    "unknown"
                  ]
                },
                "value": {
                  "type": "null"
                },
                "reason": {
                  "type": "null"
                }
              }
            },
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "state",
                "value",
                "reason"
              ],
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "known"
                  ]
                },
                "value": {
                  "type": "string",
                  "enum": [
                    "yes",
                    "no"
                  ]
                },
                "reason": {
                  "type": "null"
                }
              }
            }
          ]
        },
        "relatedContractValue": {
          "anyOf": [
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "state",
                "value",
                "reason"
              ],
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "unanswered",
                    "unknown"
                  ]
                },
                "value": {
                  "type": "null"
                },
                "reason": {
                  "type": "null"
                }
              }
            },
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "state",
                "value",
                "reason"
              ],
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "known"
                  ]
                },
                "value": {
                  "type": "object",
                  "additionalProperties": false,
                  "required": [
                    "yen",
                    "taxBasis"
                  ],
                  "properties": {
                    "yen": {
                      "type": "string",
                      "pattern": "^(0|[1-9][0-9]{0,11})$"
                    },
                    "taxBasis": {
                      "type": "string",
                      "enum": [
                        "tax_included",
                        "tax_excluded",
                        "unknown"
                      ]
                    }
                  }
                },
                "reason": {
                  "type": "null"
                }
              }
            },
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "state",
                "value",
                "reason"
              ],
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "not_applicable"
                  ]
                },
                "value": {
                  "type": "null"
                },
                "reason": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 300
                }
              }
            }
          ]
        },
        "splitReason": {
          "anyOf": [
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "state",
                "value",
                "reason"
              ],
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "unanswered",
                    "unknown"
                  ]
                },
                "value": {
                  "type": "null"
                },
                "reason": {
                  "type": "null"
                }
              }
            },
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "state",
                "value",
                "reason"
              ],
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "known"
                  ]
                },
                "value": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 500
                },
                "reason": {
                  "type": "null"
                }
              }
            },
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "state",
                "value",
                "reason"
              ],
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "not_applicable"
                  ]
                },
                "value": {
                  "type": "null"
                },
                "reason": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 300
                }
              }
            }
          ]
        },
        "subcontracting": {
          "anyOf": [
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "state",
                "value",
                "reason"
              ],
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "unanswered",
                    "unknown"
                  ]
                },
                "value": {
                  "type": "null"
                },
                "reason": {
                  "type": "null"
                }
              }
            },
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "state",
                "value",
                "reason"
              ],
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "known"
                  ]
                },
                "value": {
                  "type": "string",
                  "enum": [
                    "yes",
                    "no"
                  ]
                },
                "reason": {
                  "type": "null"
                }
              }
            }
          ]
        },
        "subcontractTotal": {
          "anyOf": [
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "state",
                "value",
                "reason"
              ],
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "unanswered",
                    "unknown"
                  ]
                },
                "value": {
                  "type": "null"
                },
                "reason": {
                  "type": "null"
                }
              }
            },
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "state",
                "value",
                "reason"
              ],
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "known"
                  ]
                },
                "value": {
                  "type": "object",
                  "additionalProperties": false,
                  "required": [
                    "yen",
                    "taxBasis"
                  ],
                  "properties": {
                    "yen": {
                      "type": "string",
                      "pattern": "^(0|[1-9][0-9]{0,11})$"
                    },
                    "taxBasis": {
                      "type": "string",
                      "enum": [
                        "tax_included",
                        "tax_excluded",
                        "unknown"
                      ]
                    }
                  }
                },
                "reason": {
                  "type": "null"
                }
              }
            },
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "state",
                "value",
                "reason"
              ],
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "not_applicable"
                  ]
                },
                "value": {
                  "type": "null"
                },
                "reason": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 300
                }
              }
            }
          ]
        }
      }
    },
    "permit": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "declaration",
        "reportedTrades",
        "note"
      ],
      "properties": {
        "declaration": {
          "anyOf": [
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "state",
                "value",
                "reason"
              ],
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "unanswered",
                    "unknown"
                  ]
                },
                "value": {
                  "type": "null"
                },
                "reason": {
                  "type": "null"
                }
              }
            },
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "state",
                "value",
                "reason"
              ],
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "known"
                  ]
                },
                "value": {
                  "type": "string",
                  "enum": [
                    "held",
                    "not_held",
                    "renewal_pending"
                  ]
                },
                "reason": {
                  "type": "null"
                }
              }
            }
          ]
        },
        "reportedTrades": {
          "anyOf": [
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "state",
                "value",
                "reason"
              ],
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "unanswered",
                    "unknown"
                  ]
                },
                "value": {
                  "type": "null"
                },
                "reason": {
                  "type": "null"
                }
              }
            },
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "state",
                "value",
                "reason"
              ],
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "known"
                  ]
                },
                "value": {
                  "type": "array",
                  "minItems": 1,
                  "maxItems": 29,
                  "uniqueItems": true,
                  "items": {
                    "type": "string",
                    "enum": [
                      "civil_general",
                      "building_general",
                      "carpentry",
                      "plastering",
                      "scaffolding_earthwork_concrete",
                      "stone",
                      "roofing",
                      "electrical",
                      "plumbing",
                      "tile_brick_block",
                      "steel_structure",
                      "reinforcing_steel",
                      "paving",
                      "dredging",
                      "sheet_metal",
                      "glass",
                      "painting",
                      "waterproofing",
                      "interior_finishing",
                      "machinery_installation",
                      "thermal_insulation",
                      "telecommunications",
                      "landscaping",
                      "well_drilling",
                      "fittings",
                      "water_facilities",
                      "fire_protection",
                      "sanitation_facilities",
                      "demolition"
                    ]
                  }
                },
                "reason": {
                  "type": "null"
                }
              }
            }
          ]
        },
        "note": {
          "type": "string",
          "minLength": 0,
          "maxLength": 1000
        }
      }
    },
    "conditions": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "electricalWork",
        "existingStructureWork",
        "demolitionWork",
        "specifiedMaterials",
        "constructionWaste",
        "structuralChange"
      ],
      "properties": {
        "electricalWork": {
          "anyOf": [
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "state",
                "value",
                "reason"
              ],
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "unanswered",
                    "unknown"
                  ]
                },
                "value": {
                  "type": "null"
                },
                "reason": {
                  "type": "null"
                }
              }
            },
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "state",
                "value",
                "reason"
              ],
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "known"
                  ]
                },
                "value": {
                  "type": "string",
                  "enum": [
                    "yes",
                    "no"
                  ]
                },
                "reason": {
                  "type": "null"
                }
              }
            }
          ]
        },
        "existingStructureWork": {
          "anyOf": [
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "state",
                "value",
                "reason"
              ],
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "unanswered",
                    "unknown"
                  ]
                },
                "value": {
                  "type": "null"
                },
                "reason": {
                  "type": "null"
                }
              }
            },
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "state",
                "value",
                "reason"
              ],
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "known"
                  ]
                },
                "value": {
                  "type": "string",
                  "enum": [
                    "yes",
                    "no"
                  ]
                },
                "reason": {
                  "type": "null"
                }
              }
            }
          ]
        },
        "demolitionWork": {
          "anyOf": [
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "state",
                "value",
                "reason"
              ],
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "unanswered",
                    "unknown"
                  ]
                },
                "value": {
                  "type": "null"
                },
                "reason": {
                  "type": "null"
                }
              }
            },
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "state",
                "value",
                "reason"
              ],
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "known"
                  ]
                },
                "value": {
                  "type": "string",
                  "enum": [
                    "yes",
                    "no"
                  ]
                },
                "reason": {
                  "type": "null"
                }
              }
            }
          ]
        },
        "specifiedMaterials": {
          "anyOf": [
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "state",
                "value",
                "reason"
              ],
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "unanswered",
                    "unknown"
                  ]
                },
                "value": {
                  "type": "null"
                },
                "reason": {
                  "type": "null"
                }
              }
            },
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "state",
                "value",
                "reason"
              ],
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "known"
                  ]
                },
                "value": {
                  "type": "string",
                  "enum": [
                    "yes",
                    "no"
                  ]
                },
                "reason": {
                  "type": "null"
                }
              }
            }
          ]
        },
        "constructionWaste": {
          "anyOf": [
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "state",
                "value",
                "reason"
              ],
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "unanswered",
                    "unknown"
                  ]
                },
                "value": {
                  "type": "null"
                },
                "reason": {
                  "type": "null"
                }
              }
            },
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "state",
                "value",
                "reason"
              ],
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "known"
                  ]
                },
                "value": {
                  "type": "string",
                  "enum": [
                    "yes",
                    "no"
                  ]
                },
                "reason": {
                  "type": "null"
                }
              }
            }
          ]
        },
        "structuralChange": {
          "anyOf": [
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "state",
                "value",
                "reason"
              ],
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "unanswered",
                    "unknown"
                  ]
                },
                "value": {
                  "type": "null"
                },
                "reason": {
                  "type": "null"
                }
              }
            },
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "state",
                "value",
                "reason"
              ],
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "known"
                  ]
                },
                "value": {
                  "type": "string",
                  "enum": [
                    "yes",
                    "no"
                  ]
                },
                "reason": {
                  "type": "null"
                }
              }
            }
          ]
        }
      }
    },
    "note": {
      "type": "string",
      "minLength": 0,
      "maxLength": 2000
    }
  }
} as const
